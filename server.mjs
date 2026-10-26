#!/usr/bin/env node
// Worktree Manager: local web UI for git worktrees + Claude Code session migration.
// No dependencies. Run: node server.mjs   (binds 127.0.0.1 only)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const HOME = os.homedir();
const REPOS_DIR = process.env.REPOS_DIR || path.join(HOME, 'Documents', 'Repos');
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(HOME, '.claude');
const CLAUDE_PROJECTS = path.join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const INTELLIJ_APP = process.env.INTELLIJ_APP || 'IntelliJ IDEA';
const PORT = Number(process.env.PORT || 7777);
// New worktrees are created as siblings: <REPOS_DIR>/<repo>-<name>
const worktreePathFor = (repoName, name) => path.join(REPOS_DIR, `${repoName}-${name}`);

// ---------- helpers ----------
const git = (cwd, ...args) => execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
const slugFor = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const projectDirFor = (p) => path.join(CLAUDE_PROJECTS, slugFor(p));
const exists = (p) => fs.promises.access(p).then(() => true, () => false);

function assertInsideRepos(p) {
  const r = path.resolve(p);
  if (!r.startsWith(REPOS_DIR + path.sep)) throw new Error(`Path outside ${REPOS_DIR}: ${p}`);
  return r;
}

async function isGitRepoRoot(dir) {
  try {
    const st = await fsp.stat(path.join(dir, '.git'));
    return st.isDirectory(); // worktrees have a .git *file*; main checkouts have a dir
  } catch { return false; }
}

async function listWorktrees(repoPath) {
  const { stdout } = await git(repoPath, 'worktree', 'list', '--porcelain');
  const out = [];
  let cur = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null, head: null, detached: false, locked: false, prunable: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

// Read the ai-title and first real user prompt of a transcript, streaming and stopping early.
async function sessionMeta(file) {
  let title = null, firstPrompt = null, firstReply = null, firstCommand = null, cwd = null, branch = null;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!title && line.includes('"type":"ai-title"')) { try { title = JSON.parse(line).aiTitle; } catch {} }
      if (!firstPrompt && !firstReply && line.includes('"type":"assistant"')) {
        try { const s = textsFromLine(JSON.parse(line), false).map(t => t.text).join(' ').trim(); if (s) firstReply = s.replace(/\s+/g, ' ').slice(0, 160); } catch {}
      }
      if ((!cwd && line.includes('"cwd":"')) || (!firstPrompt && line.includes('"type":"user"'))) {
        try {
          const j = JSON.parse(line);
          if (!cwd && j.cwd) { cwd = j.cwd; branch = j.gitBranch || null; }
          if (!firstPrompt && j.type === 'user') {
            const s = textsFromLine(j, false).map(t => t.text).join(' ').trim();
            if (s) firstPrompt = s.replace(/\s+/g, ' ').slice(0, 160);
            else if (!firstCommand) { const raw = typeof j.message?.content === 'string' ? j.message.content : ''; const m = raw.match(/<command-name>([^<]+)<\/command-name>/); if (m) firstCommand = m[1].trim(); }
          }
        } catch {}
      }
      if (title && firstPrompt && cwd) { rl.close(); break; }
    }
  } catch {}
  return { title, firstPrompt: firstPrompt || firstReply || firstCommand, cwd, branch };
}

// Shape shared by search results and the recent list.
const inScope = (cwd, scope) => !scope || cwd === scope || (cwd || '').startsWith(scope + path.sep);
async function describeSession(file, { cwd, branch, hits = 0, snippets = [], lastTs = 0, rootOf }) {
  const [st, meta] = await Promise.all([fsp.stat(file).catch(() => null), sessionMeta(file)]);
  cwd = cwd || meta.cwd; branch = branch || meta.branch;
  const cwdExists = cwd ? await exists(cwd) : false;
  const root = cwdExists ? await rootOf(cwd) : null;
  const rel = (p) => p.startsWith(REPOS_DIR + path.sep) ? path.relative(REPOS_DIR, p) : p;
  const label = cwd ? rel(root || cwd) : path.basename(path.dirname(file));
  const sub = root && root !== cwd ? path.relative(root, cwd) : '';
  return { sessionId: path.basename(file, '.jsonl'), cwd, openPath: root || cwd, label, sub, exists: cwdExists, branch, title: meta.title || meta.firstPrompt || '(no prompt)', mtime: st?.mtimeMs || lastTs, hits, snippets };
}
function makeRootResolver() {
  const cache = new Map();
  return (cwd) => { if (!cache.has(cwd)) cache.set(cwd, git(cwd, 'rev-parse', '--show-toplevel').then(r => r.stdout.trim(), () => null)); return cache.get(cwd); };
}

// Most recent chats across every project dir, optionally scoped to a folder (and its subfolders).
async function recentSessions({ n = 10, scope = null } = {}) {
  n = Math.min(Math.max(Number(n) || 10, 1), 200);
  const dirs = (await fsp.readdir(CLAUDE_PROJECTS, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
  const slug = scope ? slugFor(scope) : null;
  const candidates = slug ? dirs.filter(d => d === slug || d.startsWith(slug + '-')) : dirs; // slug prefix is a superset of the scope; verified via cwd below
  const files = [];
  await Promise.all(candidates.map(async (d) => {
    const pdir = path.join(CLAUDE_PROJECTS, d);
    for (const name of await fsp.readdir(pdir).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(pdir, name);
      const st = await fsp.stat(file).catch(() => null);
      if (st) files.push({ file, mtime: st.mtimeMs });
    }
  }));
  files.sort((a, b) => b.mtime - a.mtime);
  const rootOf = makeRootResolver();
  const out = [];
  for (let i = 0; i < files.length && out.length < n; i += 20) {
    const batch = await Promise.all(files.slice(i, i + 20).map(f => describeSession(f.file, { rootOf })));
    for (const s of batch) { if (inScope(s.cwd, scope) && out.length < n) out.push(s); }
  }
  return { sessions: out, total: files.length };
}


async function sessionsFor(dirPath) {
  const pdir = projectDirFor(dirPath);
  if (!(await exists(pdir))) return [];
  const entries = await fsp.readdir(pdir, { withFileTypes: true });
  const sessions = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const id = e.name.slice(0, -6);
    const full = path.join(pdir, e.name);
    const [st, meta] = await Promise.all([fsp.stat(full), sessionMeta(full)]);
    sessions.push({ id, title: meta.title || meta.firstPrompt || '(no prompt)', mtime: st.mtimeMs, size: st.size, hasDir: await exists(path.join(pdir, id)) });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// ---------- global chat search ----------
// Searches every transcript under ~/.claude/projects (all repos and worktrees, including deleted ones).
// Case-insensitive literal substring match; uses ripgrep when installed, otherwise a Node line scan.
const SEARCH_MAX_OUTPUT = 64 * 1024 * 1024; // bytes of rg output before we stop and report "truncated"
const SEARCH_MAX_LINES_PER_FILE = 200;
let rgAvailable = null;

// Pull the human-readable text out of one transcript line. role: user | assistant | tool.
function textsFromLine(j, includeTools) {
  const out = [];
  if ((j.type !== 'user' && j.type !== 'assistant') || j.isMeta) return out;
  const clean = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const pushText = (t) => { const c = clean(t); if (c && !c.startsWith('<')) out.push({ role: j.type, text: c }); };
  const c = j.message?.content;
  if (typeof c === 'string') { pushText(c); return out; }
  if (!Array.isArray(c)) return out;
  for (const b of c) {
    if (b.type === 'text' && typeof b.text === 'string') pushText(b.text);
    else if (includeTools && b.type === 'tool_use') out.push({ role: 'tool', text: JSON.stringify(b.input ?? '') });
    else if (includeTools && b.type === 'tool_result') {
      const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
      if (t) out.push({ role: 'tool', text: t });
    }
  }
  return out;
}

function snippetFor(text, q, radius = 90) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const s = Math.max(0, i - radius), e = Math.min(text.length, i + q.length + radius);
  const ws = (t) => t.replace(/\s+/g, ' ');
  return { before: (s > 0 ? '…' : '') + ws(text.slice(s, i)), match: text.slice(i, i + q.length), after: ws(text.slice(i + q.length, e)) + (e < text.length ? '…' : '') };
}

// Calls onLine(file, rawLine) for every transcript line containing q. Resolves to true if output was capped.
async function grepProjects(q, onLine) {
  if (rgAvailable === null) rgAvailable = await execFileP('rg', ['--version']).then(() => true, () => false);
  if (rgAvailable) {
    return new Promise((resolve, reject) => {
      const child = spawn('rg', ['--json', '-i', '-F', '--no-messages', '--max-count', String(SEARCH_MAX_LINES_PER_FILE), '--glob', '*.jsonl', '--', q, CLAUDE_PROJECTS]);
      let buf = '', total = 0, truncated = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        total += chunk.length;
        if (total > SEARCH_MAX_OUTPUT && !truncated) { truncated = true; child.kill(); }
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line) continue;
          try { const ev = JSON.parse(line); if (ev.type === 'match' && ev.data?.lines?.text) onLine(ev.data.path.text, ev.data.lines.text); } catch {}
        }
      });
      child.on('error', reject);
      child.on('close', () => resolve(truncated));
    });
  }
  const lq = q.toLowerCase();
  for (const d of await fsp.readdir(CLAUDE_PROJECTS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const pdir = path.join(CLAUDE_PROJECTS, d.name);
    for (const n of await fsp.readdir(pdir)) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(pdir, n);
      const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
      let count = 0;
      for await (const line of rl) {
        if (!line.toLowerCase().includes(lq)) continue;
        onLine(file, line);
        if (++count >= SEARCH_MAX_LINES_PER_FILE) { rl.close(); break; }
      }
    }
  }
  return false;
}

async function searchChats(q, { includeTools = false, scope = null } = {}) {
  q = String(q || '').trim();
  if (q.length < 2 || q.length > 200) throw new Error('Search text must be 2–200 characters');
  const byFile = new Map();
  const truncated = await grepProjects(q, (file, raw) => {
    let j; try { j = JSON.parse(raw); } catch { return; }
    if (scope && j.cwd && !inScope(j.cwd, scope)) return;
    for (const t of textsFromLine(j, includeTools)) {
      const sn = snippetFor(t.text, q); if (!sn) continue;
      let e = byFile.get(file);
      if (!e) { e = { file, sessionId: j.sessionId || path.basename(file, '.jsonl'), cwd: j.cwd || null, branch: j.gitBranch || null, hits: 0, snippets: [], lastTs: 0 }; byFile.set(file, e); }
      e.hits++;
      const ts = Date.parse(j.timestamp || '') || 0; if (ts > e.lastTs) e.lastTs = ts;
      if (e.snippets.length < 3) e.snippets.push({ role: t.role, ts, ...sn });
    }
  });
  const rootOf = makeRootResolver();
  const sessions = (await Promise.all([...byFile.values()].map(e => describeSession(e.file, { ...e, rootOf })))).filter(s => inScope(s.cwd, scope));
  sessions.sort((a, b) => b.mtime - a.mtime);
  return { query: q, total: sessions.length, sessions: sessions.slice(0, 100), truncated };
}

// Cheap stats for a path's Claude project dir: number of chats and newest chat mtime (ms).
async function sessionStats(dirPath) {
  const pdir = projectDirFor(dirPath);
  if (!(await exists(pdir))) return { count: 0, last: 0 };
  const names = (await fsp.readdir(pdir)).filter(n => n.endsWith('.jsonl'));
  const mtimes = await Promise.all(names.map(n => fsp.stat(path.join(pdir, n)).then(st => st.mtimeMs, () => 0)));
  return { count: names.length, last: mtimes.length ? Math.max(...mtimes) : 0 };
}

async function listRepos() {
  const entries = await fsp.readdir(REPOS_DIR, { withFileTypes: true });
  const repos = await Promise.all(entries.map(async (e) => {
    if (!e.isDirectory() || e.name.startsWith('.')) return null;
    const p = path.join(REPOS_DIR, e.name);
    if (!(await isGitRepoRoot(p))) return null;
    try {
      const [branchOut, wtsAll] = await Promise.all([git(p, 'rev-parse', '--abbrev-ref', 'HEAD'), listWorktrees(p)]);
      const worktrees = wtsAll.filter(w => path.resolve(w.path) !== path.resolve(p));
      await Promise.all(worktrees.map(async (w) => { w.exists = await exists(w.path); const st = await sessionStats(w.path); w.sessionCount = st.count; w.lastActivity = st.last; }));
      worktrees.sort((a, b) => b.lastActivity - a.lastActivity || a.path.localeCompare(b.path));
      const main = await sessionStats(p);
      const lastActivity = Math.max(main.last, ...worktrees.map(w => w.lastActivity));
      return { name: e.name, path: p, branch: branchOut.stdout.trim(), worktrees, sessionCount: main.count, mainLastActivity: main.last, lastActivity };
    } catch (err) { return { name: e.name, path: p, error: String(err.message) }; }
  }));
  // Most recently used Claude chat first (across main + worktrees); repos without chats last, alphabetical.
  return repos.filter(Boolean).sort((a, b) => ((b.lastActivity || 0) - (a.lastActivity || 0)) || a.name.localeCompare(b.name));
}

async function defaultBase(repoPath) {
  try {
    const { stdout } = await git(repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    return stdout.trim(); // e.g. origin/main
  } catch { return 'HEAD'; }
}

async function createWorktree({ repo, branch, base, fetch }) {
  const repoPath = assertInsideRepos(path.join(REPOS_DIR, repo));
  if (!branch || !/^[\w.\/-]+$/.test(branch)) throw new Error('Invalid branch name');
  await git(repoPath, 'check-ref-format', '--branch', branch);
  const name = branch.replace(/\//g, '-');
  const target = worktreePathFor(repo, name);
  if (await exists(target)) throw new Error(`Target already exists: ${target}`);
  if (fetch) await git(repoPath, 'fetch', '--prune');
  const localExists = await git(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false);
  const remoteExists = await git(repoPath, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`).then(() => true, () => false);
  if (localExists) await git(repoPath, 'worktree', 'add', target, branch);
  else if (remoteExists) await git(repoPath, 'worktree', 'add', '--track', '-b', branch, target, `origin/${branch}`);
  else await git(repoPath, 'worktree', 'add', '-b', branch, target, base || await defaultBase(repoPath));
  return { path: target, mode: localExists ? 'existing-local' : remoteExists ? 'tracked-remote' : 'new-branch' };
}

async function openInIntelliJ(p) {
  const target = path.resolve(p);
  if (!(await exists(target))) throw new Error(`Directory does not exist: ${target}`);
  await execFileP('open', ['-a', `${INTELLIJ_APP}.app`, target]);
}

// Copy selected sessions from srcPath's Claude project dir into dstPath's, rewriting the path inside.
async function migrateSessions({ srcPath, dstPath, ids }) {
  const srcDir = projectDirFor(srcPath), dstDir = projectDirFor(dstPath);
  await fsp.mkdir(dstDir, { recursive: true });
  const results = [];
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/.test(id)) { results.push({ id, error: 'bad id' }); continue; }
    const srcFile = path.join(srcDir, `${id}.jsonl`), dstFile = path.join(dstDir, `${id}.jsonl`);
    if (await exists(dstFile)) { results.push({ id, error: 'already exists in target' }); continue; }
    const text = await fsp.readFile(srcFile, 'utf8');
    await fsp.writeFile(dstFile, text.split(srcPath).join(dstPath), { mode: 0o600 });
    const srcSub = path.join(srcDir, id);
    if (await exists(srcSub)) await fsp.cp(srcSub, path.join(dstDir, id), { recursive: true });
    results.push({ id, ok: true });
  }
  // Keep ~/.claude/history.jsonl consistent so prompt history follows the session.
  const moved = new Set(results.filter(r => r.ok).map(r => r.id));
  if (moved.size && await exists(HISTORY_FILE)) {
    const raw = await fsp.readFile(HISTORY_FILE, 'utf8');
    await fsp.writeFile(`${HISTORY_FILE}.bak-${Date.now()}`, raw);
    const lines = raw.split('\n').map(line => {
      if (!line) return line;
      try {
        const j = JSON.parse(line);
        if (moved.has(j.sessionId) && j.project === srcPath) { j.project = dstPath; return JSON.stringify(j); }
      } catch {}
      return line;
    });
    await fsp.writeFile(HISTORY_FILE, lines.join('\n'));
  }
  return results;
}

async function deleteWorktree({ repo, path: wtPath, migrate = [], force = false, deleteBranch = false, deleteRemainingSessions = false }) {
  const repoPath = assertInsideRepos(path.join(REPOS_DIR, repo));
  const target = path.resolve(wtPath);
  const wts = await listWorktrees(repoPath);
  const wt = wts.find(w => path.resolve(w.path) === target);
  if (!wt) throw new Error('Not a worktree of this repo');
  if (target === path.resolve(repoPath)) throw new Error('Refusing to remove main worktree');
  const migrated = migrate.length ? await migrateSessions({ srcPath: target, dstPath: repoPath, ids: migrate }) : [];
  const args = ['worktree', 'remove']; if (force) args.push('--force'); args.push(target);
  if (await exists(target)) await git(repoPath, ...args); else await git(repoPath, 'worktree', 'prune');
  let branchDeleted = false;
  if (deleteBranch && wt.branch) { await git(repoPath, 'branch', '-D', wt.branch); branchDeleted = true; }
  let sessionsDirRemoved = false;
  if (deleteRemainingSessions) {
    const pdir = projectDirFor(target);
    if (await exists(pdir)) { await fsp.rm(pdir, { recursive: true, force: true }); sessionsDirRemoved = true; }
  }
  return { migrated, branchDeleted, sessionsDirRemoved };
}

// ---------- http ----------
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) reject(new Error('body too large')); }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(await fsp.readFile(path.join(__dirname, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end(await fsp.readFile(path.join(__dirname, 'app.js')));
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { reposDir: REPOS_DIR, claudeProjects: CLAUDE_PROJECTS, intellij: INTELLIJ_APP });
    if (req.method === 'GET' && url.pathname === '/api/repos') return json(res, 200, await listRepos());
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, 200, await sessionsFor(assertInsideRepos(url.searchParams.get('path') || '')));
    if (req.method === 'GET' && url.pathname === '/api/search') return json(res, 200, await searchChats(url.searchParams.get('q'), { includeTools: url.searchParams.get('tools') === '1', scope: url.searchParams.get('path') ? assertInsideRepos(url.searchParams.get('path')) : null }));
    if (req.method === 'GET' && url.pathname === '/api/recent') return json(res, 200, await recentSessions({ n: url.searchParams.get('n'), scope: url.searchParams.get('path') ? assertInsideRepos(url.searchParams.get('path')) : null }));
    if (req.method === 'GET' && url.pathname === '/api/default-base') return json(res, 200, { base: await defaultBase(assertInsideRepos(path.join(REPOS_DIR, url.searchParams.get('repo') || ''))) });
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (url.pathname === '/api/worktree/create') return json(res, 200, await createWorktree(body));
      if (url.pathname === '/api/worktree/open') { await openInIntelliJ(body.path); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/worktree/delete') return json(res, 200, await deleteWorktree(body));
      if (url.pathname === '/api/worktree/prune') { await git(assertInsideRepos(path.join(REPOS_DIR, body.repo)), 'worktree', 'prune'); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/sessions/migrate') return json(res, 200, await migrateSessions({ srcPath: assertInsideRepos(body.srcPath), dstPath: assertInsideRepos(body.dstPath), ids: body.ids || [] }));
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 400, { error: (err.stderr && String(err.stderr).trim()) || err.message || String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = `http://127.0.0.1:${PORT}`;
  console.log(`Worktree Manager on ${addr}  (repos: ${REPOS_DIR})`);
  if (process.env.NO_OPEN !== '1') execFile('open', [addr], () => {});
});
