/*
 * Agent-suite toggle — a compact segmented control in the chat top bar that
 * switches the active chat to one of the 3 pinned agent sessions
 * (Windows Agent / Game Agent / Odysseus Architect). Each role's pinned
 * session carries its own model + role guard rails + scoped lessons (P4), so
 * selecting a role is "talk to that agent". Renders only when a suite has been
 * provisioned; otherwise it stays invisible and out of the way.
 */
import { selectSession, getCurrentSessionId } from './sessions.js';

const API_BASE = window.location.origin;
const ROLE_ORDER = ['windows', 'game', 'architect'];
const FALLBACK_NAMES = {
  windows: 'Windows Agent',
  game: 'Game Agent',
  architect: 'FoulFox VM Architect',
};
const SHORT = { windows: 'Windows', game: 'Game', architect: 'Architect' };

let _members = {};   // role -> session_id
let _wrap = null;
let _observer = null;

function _injectStyles() {
  if (document.getElementById('as-toggle-styles')) return;
  const css = `
  /* left:44px clears every left-corner occupant in all sidebar modes:
     .incognito-indicator (left:12px, ~24px wide), the right-sidebar
     .chat-new-btn (left:12px), and the collapsed hamburger's 38px region.
     Absolute offset is measured from the padding box, so it is unaffected
     by the collapsed top-bar's padding-left. */
  .as-toggle { position:absolute; left:44px; top:50%; transform:translateY(-50%);
    z-index:3; display:inline-flex; align-items:center; gap:2px; padding:2px;
    border:1px solid var(--border,#355a66); border-radius:7px;
    background:color-mix(in srgb, var(--panel,#111) 88%, var(--bg,#282c34)); }
  .as-toggle-label { font-size:9px; text-transform:uppercase; letter-spacing:.06em;
    opacity:.5; padding:0 5px 0 3px; color:var(--fg,#9cdef2); user-select:none; }
  .as-toggle-btn { appearance:none; border:0; cursor:pointer; font:inherit;
    font-size:10.5px; font-weight:600; line-height:1; padding:4px 8px;
    border-radius:5px; color:var(--fg,#9cdef2); background:transparent;
    opacity:.7; white-space:nowrap; transition:background .12s, opacity .12s; }
  .as-toggle-btn:hover { opacity:1;
    background:color-mix(in srgb, var(--fg,#9cdef2) 12%, transparent); }
  .as-toggle-btn.active { opacity:1; color:#fff;
    background:var(--accent, var(--red,#e06c75)); }
  @media (max-width:768px){ .as-toggle-label{ display:none; } }
  `;
  const style = document.createElement('style');
  style.id = 'as-toggle-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function _refreshActive() {
  if (!_wrap) return;
  let cur = null;
  try { cur = getCurrentSessionId(); } catch { /* ignore */ }
  _wrap.querySelectorAll('.as-toggle-btn').forEach((btn) => {
    const sid = btn.dataset.sessionId;
    btn.classList.toggle('active', !!sid && sid === cur);
  });
}

// Remove the rendered toggle and stop its observer. Safe to call repeatedly;
// used both before a rebuild and when a deprovision leaves no suite to show.
function _teardown() {
  const existing = document.getElementById('agent-suite-toggle');
  if (existing) existing.remove();
  if (_observer) { try { _observer.disconnect(); } catch { /* ignore */ } _observer = null; }
  _wrap = null;
}

function _build(roleNames) {
  const bar = document.querySelector('.chat-top-bar');
  if (!bar) return;

  // Idempotent: tear down any previous instance before rebuilding so a
  // re-provision (suite-changed) never leaves a duplicate control behind.
  _teardown();

  _injectStyles();

  const wrap = document.createElement('div');
  wrap.className = 'as-toggle';
  wrap.id = 'agent-suite-toggle';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Switch agent');

  const label = document.createElement('span');
  label.className = 'as-toggle-label';
  label.textContent = 'Agents';
  wrap.appendChild(label);

  ROLE_ORDER.forEach((role) => {
    const sid = _members[role];
    if (!sid) return;
    const fullName = (roleNames && roleNames[role]) || FALLBACK_NAMES[role] || role;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'as-toggle-btn';
    btn.dataset.role = role;
    btn.dataset.sessionId = sid;
    btn.textContent = SHORT[role] || role;
    btn.title = fullName;
    btn.setAttribute('aria-label', 'Switch to ' + fullName);
    btn.addEventListener('click', async () => {
      try {
        await selectSession(sid);
      } catch (e) {
        console.error('agent toggle: selectSession failed', e);
      }
      _refreshActive();
    });
    wrap.appendChild(btn);
  });

  if (!wrap.querySelector('.as-toggle-btn')) return;   // nothing to switch to

  bar.insertBefore(wrap, bar.firstChild);
  _wrap = wrap;

  // Keep the active highlight synced with whatever switches the session
  // (sidebar clicks, URL hash, our own buttons). `#current-meta` text is
  // rewritten on every selectSession, so observe it.
  const meta = document.getElementById('current-meta');
  if (meta) {
    try {
      _observer = new MutationObserver(_refreshActive);
      _observer.observe(meta, { childList: true, characterData: true, subtree: true });
    } catch { /* observer unsupported — highlight still updates on click */ }
  }
  _refreshActive();
}

async function _load() {
  let data = null;
  try {
    const res = await fetch(`${API_BASE}/api/agent-suite/state`, { credentials: 'same-origin' });
    if (!res.ok) return;   // transient (e.g. 5xx) — leave any current toggle in place
    data = await res.json();
  } catch (e) {
    // Non-fatal: a transient fetch/parse error leaves any existing toggle alone.
    console.debug('agent-suite toggle load skipped:', e && e.message);
    return;
  }
  // `data` now reflects authoritative suite state, so a missing suite or empty
  // membership means we must remove a stale toggle (e.g. after a deprovision).
  const suite = data && data.suite;
  if (!suite || !Array.isArray(suite.members)) { _teardown(); _members = {}; return; }
  const members = {};
  suite.members.forEach((m) => {
    if (m && m.role && m.session_id) members[m.role] = m.session_id;
  });
  if (!Object.keys(members).length) { _teardown(); _members = {}; return; }
  _members = members;
  const roleNames = {};
  if (Array.isArray(data.roles)) {
    data.roles.forEach((r) => { if (r && r.role) roleNames[r.role] = r.name; });
  }
  _build(roleNames);
}

function _init() {
  _load();
  // Pick up a suite provisioned after first paint (e.g. via the shell setup
  // wizard) without forcing a hard reload of the embedded UI.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !_wrap) _load();
  });
  window.addEventListener('odysseus:suite-changed', _load);
  // Registered once here (not per rebuild). _refreshActive no-ops when no
  // toggle is mounted, so a single global listener is leak-free and correct.
  window.addEventListener('hashchange', _refreshActive);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

export default { reload: _load, refresh: _refreshActive };
