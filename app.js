const $ = (s, el = document) => el.querySelector(s);
const api = async (url, body) => {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const ago = (ms) => { if (!ms) return ''; const d = Date.now() - ms, m = Math.round(d / 6e4); if (m < 60) return m <= 1 ? 'just now' : m + ' min ago'; const h = Math.round(m / 60); if (h < 48) return h + ' h ago'; const days = Math.round(h / 24); return days < 30 ? days + ' d ago' : fmtDate(ms); };
const fmtSize = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';

let toastTimer;
function toast(msg, cls = '') {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.className = 'toast ' + cls; t.textContent = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), cls === 'err' ? 9000 : 4000);
}
const busy = async (btn, fn) => { btn.disabled = true; try { return await fn(); } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; } };

let repos = [];
const TOP_N = 5;
let showAll = false;
const open = new Set(JSON.parse(localStorage.getItem('wm.open') || '[]'));

async function load() {
  const [cfg, list] = await Promise.all([api('/api/config'), api('/api/repos')]);
  $('#cfg').textContent = cfg.reposDir;
  repos = list; render();
}

function render() {
  const q = $('#filter').value.trim().toLowerCase();
  const main = $('#repos'); main.innerHTML = '';
  const matches = repos.filter(r => !q || r.name.toLowerCase().includes(q) || (r.worktrees || []).some(w => w.path.toLowerCase().includes(q) || (w.branch || '').toLowerCase().includes(q)));
  const visible = (q || showAll) ? matches : matches.slice(0, TOP_N);
  for (const r of visible) {
    const card = document.createElement('section'); card.className = 'card';
    const isOpen = open.has(r.name) || !!q;
    card.innerHTML = `
      <div class="repo-head">
        <span>${isOpen ? '▾' : '▸'}</span><h2>${esc(r.name)}</h2>
        <span class="main-chip">${esc(r.branch || '')}</span>
        <span class="badge">${(r.worktrees || []).length} worktrees</span>
        <span class="badge">${r.sessionCount ?? 0} chats</span>
        <span class="muted">${r.lastActivity ? 'last chat ' + ago(r.lastActivity) : 'no chats'}</span>
        <span class="spacer"></span>
        <div class="actions">
          <button data-act="sessions-main">Chats</button>
          <button data-act="open-main">Open in IntelliJ</button>
          <button data-act="prune" title="git worktree prune">Prune</button>
          <button class="primary" data-act="create">+ New worktree</button>
        </div>
      </div>`;
    if (r.error) card.innerHTML += `<div class="empty">${esc(r.error)}</div>`;
    if (isOpen) {
      if (!(r.worktrees || []).length) card.innerHTML += `<div class="empty">No worktrees.</div>`;
      for (const w of r.worktrees || []) {
        const row = document.createElement('div'); row.className = 'wt';
        row.innerHTML = `
          <div>
            <div class="name">${esc(w.branch || (w.detached ? 'detached @ ' + w.head : '?'))} ${w.locked ? '<span class="badge">locked</span>' : ''} ${w.prunable || !w.exists ? '<span class="badge missing">missing on disk</span>' : ''}</div>
            <div class="path">${esc(w.path)}${w.lastActivity ? ` <span class="muted">· last chat ${ago(w.lastActivity)}</span>` : ''}</div>
          </div>
          <div class="actions">
            <button data-act="sessions">Chats (${w.sessionCount})</button>
            <button data-act="open" ${w.exists ? '' : 'disabled'}>Open in IntelliJ</button>
            <button class="danger" data-act="delete">Delete</button>
          </div>`;
        row.addEventListener('click', (e) => onWtAction(e, r, w));
        card.appendChild(row);
      }
    }
    card.querySelector('.repo-head').addEventListener('click', (e) => onRepoAction(e, r));
    main.appendChild(card);
  }
  if (!main.children.length) main.innerHTML = '<p class="muted">No git repos found.</p>';
  if (!q && matches.length > TOP_N) {
    const b = document.createElement('button'); b.className = 'show-more';
    b.textContent = showAll ? 'Show only top ' + TOP_N : `Show ${matches.length - TOP_N} more repos`;
    b.onclick = () => { showAll = !showAll; render(); };
    main.appendChild(b);
  }
}

function onRepoAction(e, r) {
  const act = e.target.dataset.act;
  if (!act) { open.has(r.name) ? open.delete(r.name) : open.add(r.name); localStorage.setItem('wm.open', JSON.stringify([...open])); return render(); }
  e.stopPropagation();
  if (act === 'open-main') busy(e.target, () => api('/api/worktree/open', { path: r.path }));
  if (act === 'prune') busy(e.target, async () => { await api('/api/worktree/prune', { repo: r.name }); toast('Pruned', 'ok'); await load(); });
  if (act === 'create') showCreate(r);
  if (act === 'sessions-main') showSessions(r, { path: r.path }, true);
}

function onWtAction(e, r, w) {
  const act = e.target.dataset.act; if (!act) return;
  if (act === 'open') busy(e.target, () => api('/api/worktree/open', { path: w.path }));
  if (act === 'delete') showDelete(r, w);
  if (act === 'sessions') showSessions(r, w, false);
}

// ----- create -----
async function showCreate(r) {
  const d = $('#dlg-create');
  $('#create-repo').textContent = r.name; $('#create-branch').value = '';
  $('#create-base').value = ''; $('#create-hint').textContent = `Will be created at ${$('#cfg').textContent}/${r.name}-<branch with / replaced by ->`;
  api(`/api/default-base?repo=${encodeURIComponent(r.name)}`).then(j => { if (!$('#create-base').value) $('#create-base').placeholder = j.base; }).catch(() => {});
  d.showModal(); $('#create-branch').focus();
  $('#create-cancel').onclick = () => d.close();
  $('#create-ok').onclick = () => busy($('#create-ok'), async () => {
    const branch = $('#create-branch').value.trim(); if (!branch) throw new Error('Branch name required');
    const res = await api('/api/worktree/create', { repo: r.name, branch, base: $('#create-base').value.trim() || undefined, fetch: $('#create-fetch').checked });
    d.close(); toast(`Created (${res.mode}): ${res.path}`, 'ok'); open.add(r.name); await load();
  });
}

// ----- sessions list helper -----
function sessionRows(container, sessions) {
  container.innerHTML = sessions.length ? '' : '<div class="empty">No Claude sessions for this path.</div>';
  for (const s of sessions) {
    const row = document.createElement('label'); row.className = 'session';
    row.innerHTML = `<input type="checkbox" value="${esc(s.id)}"><span class="t" title="${esc(s.title)}">${esc(s.title)}</span><span class="m">${fmtDate(s.mtime)} · ${fmtSize(s.size)}</span>`;
    container.appendChild(row);
  }
}
const checkedIds = (container) => [...container.querySelectorAll('input:checked')].map(i => i.value);

// ----- delete -----
async function showDelete(r, w) {
  const d = $('#dlg-delete');
  $('#delete-path').textContent = w.path;
  $('#delete-force').checked = false; $('#delete-branch').checked = false; $('#delete-remaining').checked = false;
  const box = $('#delete-sessions'); box.innerHTML = '<div class="empty">Loading sessions…</div>';
  d.showModal();
  const sessions = await api(`/api/sessions?path=${encodeURIComponent(w.path)}`).catch(e => { toast(e.message, 'err'); return []; });
  $('#delete-sessions-hint').textContent = sessions.length ? `Tick the Claude chats to move into ${r.name} before deleting. Unticked chats stay where they are unless you choose to delete them.` : '';
  sessionRows(box, sessions);
  $('#sel-all').onclick = () => box.querySelectorAll('input').forEach(i => i.checked = true);
  $('#sel-none').onclick = () => box.querySelectorAll('input').forEach(i => i.checked = false);
  $('#delete-cancel').onclick = () => d.close();
  $('#delete-ok').onclick = () => busy($('#delete-ok'), async () => {
    const migrate = checkedIds(box);
    const res = await api('/api/worktree/delete', { repo: r.name, path: w.path, migrate, force: $('#delete-force').checked, deleteBranch: $('#delete-branch').checked, deleteRemainingSessions: $('#delete-remaining').checked });
    d.close();
    const failed = res.migrated.filter(m => m.error);
    toast(`Deleted. Migrated ${res.migrated.filter(m => m.ok).length} chat(s)${failed.length ? `, ${failed.length} failed: ${failed.map(f => f.error).join('; ')}` : ''}${res.branchDeleted ? ', branch deleted' : ''}`, failed.length ? 'err' : 'ok');
    await load();
  });
}

// ----- sessions viewer / manual migrate -----
async function showSessions(r, w, isMain) {
  const d = $('#dlg-sessions');
  $('#sessions-path').textContent = w.path;
  const box = $('#sessions-list'); box.innerHTML = '<div class="empty">Loading…</div>';
  $('#sessions-migrate').style.display = isMain ? 'none' : '';
  d.showModal();
  sessionRows(box, await api(`/api/sessions?path=${encodeURIComponent(w.path)}`).catch(e => { toast(e.message, 'err'); return []; }));
  $('#sessions-close').onclick = () => d.close();
  $('#sessions-migrate').onclick = () => busy($('#sessions-migrate'), async () => {
    const ids = checkedIds(box); if (!ids.length) throw new Error('Select at least one chat');
    const res = await api('/api/sessions/migrate', { srcPath: w.path, dstPath: r.path, ids });
    const failed = res.filter(m => m.error);
    toast(`Copied ${res.filter(m => m.ok).length} chat(s) to ${r.name}${failed.length ? `; failed: ${failed.map(f => f.id.slice(0, 8) + ' ' + f.error).join(', ')}` : ''}`, failed.length ? 'err' : 'ok');
    d.close(); await load();
  });
}

// ----- global chat search (all repos + worktrees, including deleted ones) -----
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const CLAUDE_MARK = '<svg class="claude-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.6 3.2l1.2 5.6 5.6 1.2-5.6 1.2-1.2 5.6-1.2-5.6-5.6-1.2 5.6-1.2z"/><path fill="currentColor" d="M5.2 14.8l.7 2.8 2.8.7-2.8.7-.7 2.8-.7-2.8-2.8-.7 2.8-.7z"/></svg>';
const roleLabel = (role) => role === 'assistant' ? `<span class="role claude">${CLAUDE_MARK}Claude</span>` : role === 'user' ? '<span class="role you">You</span>' : '<span class="role tool">Tool</span>';
let searchTimer;
async function runSearch() {
  const q = $('#search').value.trim();
  history.replaceState(null, '', q.length >= 2 ? `?q=${encodeURIComponent(q)}` : location.pathname);
  const box = $('#search-results'), reposEl = $('#repos');
  if (q.length < 2) { box.hidden = true; reposEl.hidden = false; box.innerHTML = ''; return; }
  box.hidden = false; reposEl.hidden = true;
  box.innerHTML = '<p class="muted">Searching…</p>';
  let res;
  try { res = await api(`/api/search?q=${encodeURIComponent(q)}&tools=${$('#search-tools').checked ? 1 : 0}`); }
  catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  if ($('#search').value.trim() !== q) return; // a newer search is already running
  box.innerHTML = `<p class="muted">${res.total} chat${res.total === 1 ? '' : 's'} match “${esc(q)}”${res.total > res.sessions.length ? `, showing newest ${res.sessions.length}` : ''}${res.truncated ? ' · too many hits, results capped, narrow the search' : ''}</p>`;
  for (const s of res.sessions) {
    const card = document.createElement('section'); card.className = 'card hit';
    card.innerHTML = `
      <div class="repo-head">
        <h2 title="${esc(s.cwd || '')}">${esc(s.label)}${s.sub ? `<span class="sub">/${esc(s.sub)}</span>` : ''}</h2>
        ${s.branch ? `<span class="main-chip">${esc(s.branch)}</span>` : ''}
        ${s.exists ? '' : '<span class="badge missing">folder gone</span>'}
        <span class="badge">${s.hits} hit${s.hits === 1 ? '' : 's'}</span>
        <span class="muted when" title="${esc(fmtDate(s.mtime))}">${ago(s.mtime)}</span>
        <span class="spacer"></span>
        <div class="actions">
          <button data-act="copy" title="Copies: cd <folder> && claude --resume <id>">Copy resume command</button>
          <button data-act="open" ${s.exists ? '' : 'disabled'}>Open in IntelliJ</button>
        </div>
      </div>
      <div class="hit-title" title="${esc(s.title)}">${esc(s.title)}</div>
      ${s.snippets.map(sn => `<div class="snip">${roleLabel(sn.role)}<span class="txt">${esc(sn.before)}<mark>${esc(sn.match)}</mark>${esc(sn.after)}</span></div>`).join('')}`;
    card.addEventListener('click', (e) => {
      const act = e.target.dataset.act; if (!act) return;
      if (act === 'open') busy(e.target, () => api('/api/worktree/open', { path: s.openPath }));
      if (act === 'copy') {
        const cmd = `cd ${shellQuote(s.cwd)} && claude --resume ${s.sessionId}`;
        const note = s.exists ? '' : ' (folder is gone: migrate this chat to the parent repo via Chats first)';
        navigator.clipboard.writeText(cmd).then(() => toast('Copied: ' + cmd + note, 'ok'), () => toast(cmd + note));
      }
    });
    box.appendChild(card);
  }
  if (!res.sessions.length) box.innerHTML += '<p class="muted">No chats contain that text.</p>';
}
$('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); };
$('#search').onkeydown = (e) => { if (e.key === 'Escape') { $('#search').value = ''; runSearch(); } };
$('#search-tools').onchange = runSearch;
document.addEventListener('keydown', (e) => { if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) { e.preventDefault(); $('#search').focus(); $('#search').select(); } });
{ const q0 = new URLSearchParams(location.search).get('q'); if (q0) { $('#search').value = q0; runSearch(); } }

$('#refresh').onclick = () => load().catch(e => toast(e.message, 'err'));
$('#filter').oninput = render;
load().catch(e => toast(e.message, 'err'));
