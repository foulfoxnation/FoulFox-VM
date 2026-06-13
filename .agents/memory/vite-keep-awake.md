---
name: Vite dev preview stale white-page fix
description: Why the Replit Vite preview goes blank on long/idle sessions and the keep-awake mitigation.
---

# Vite dev preview goes stale / white-pages on long sessions

In Replit, a long-lived or backgrounded Vite dev preview tab can go blank
("white page") and lose in-page state. Cause: a hidden/idle tab has its
main-thread timers throttled (~once/min) and the browser may close the Vite HMR
WebSocket; the dev server then loses the client and the proxied preview serves a
blank/stale page on return. Device/screen sleep during long idle sessions
produces the same symptom.

**Mitigation (keep-awake), no page reloads so unsaved work is preserved:**
- Heartbeat the dev server with a periodic same-origin `fetch(BASE_URL, {method:'HEAD', cache:'no-store'})`, driven by a **Web Worker** interval (worker timers survive background throttling better than main-thread `setInterval`). This keeps the connection — and the Replit workflow — warm.
- Hold a Screen Wake Lock (`navigator.wakeLock.request('screen')`) while visible; re-acquire on `visibilitychange` (it auto-releases when hidden).

**Why no reload:** the user's goal is to NOT lose unsaved in-page work; Vite's own
full reload on HMR reconnect is part of the problem, so the fix prevents the
disconnect rather than recovering via reload.

**How to apply:**
- Gate strictly to dev + browser: run only when `import.meta.env.DEV` and
  `window.location.protocol !== 'file:'` (packaged Electron has no Vite server).
- Track the worker/listener/wake-lock on a `window`-scoped handle and tear it
  down in `import.meta.hot.dispose`, or HMR re-execution of the module will
  leak a new worker+listener on every hot update across a long session.
