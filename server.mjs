#!/usr/bin/env node
// Worktree Manager: local web UI for git worktrees + Claude Code session migration.
// No dependencies. Run: node server.mjs   (binds 127.0.0.1 only)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
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

async function sessionsFor(dirPath) {
  const pdir = projectDirFor(dirPath);
  if (!(await exists(pdir))) return [];
  const entries = await fsp.readdir(pdir, { withFileTypes: true });
  const sessions = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const id = e.name.slice(0, -6);
    const full = path.join(pdir, e.name);
    const st = await fsp.stat(full);
    let title = null, firstPrompt = null;
    try {
      const text = await fsp.readFile(full, 'utf8');
      for (const line of text.split('\n')) {
        if (!title && line.includes('"type":"ai-title"')) { try { title = JSON.parse(line).aiTitle; } catch {} }
        if (!firstPrompt && line.includes('"type":"user"')) {
          try {
            const j = JSON.parse(line);
            const c = j.message?.content;
            const s = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
            if (s && !s.startsWith('<')) firstPrompt = s.slice(0, 160);
          } catch {}
        }
        if (title && firstPrompt) break;
      }
    } catch {}
    sessions.push({ id, title: title || firstPrompt || '(no prompt)', mtime: st.mtimeMs, size: st.size, hasDir: await exists(path.join(pdir, id)) });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
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
