// FoulFox Apps in the sidebar: lists installed apps and opens each one as a
// full-window overlay (iframe onto the api-server's app UI proxy).
//
// The list is fetched through Odysseus (/api/foulfox-apps) because in-page
// fetches are rewritten to the Odysseus proxy prefix by the shell's shim. The
// iframe src, however, is set via DOM assignment — the shim does NOT rewrite
// element URLs — so a root-absolute /api/apps/<id>/ui/ resolves against the
// SHELL origin and reaches the api-server proxy directly (dev), while on the
// appliance the dedicated loopback uiBase origin is used instead.

const LIST_URL = "/api/foulfox-apps";
const REFRESH_MS = 30000;

let apps = [];
let uiBase = null;
let overlay = null;

function appUiSrc(id) {
  const p = `/api/apps/${encodeURIComponent(id)}/ui/`;
  return uiBase ? `${uiBase}${p}` : p;
}

async function fetchApps() {
  try {
    const r = await fetch(LIST_URL);
    if (!r.ok) return;
    const data = await r.json();
    apps = (data.apps || []).filter((a) => a && a.status === "installed");
    uiBase = data.uiBase || null;
    render();
  } catch {
    /* api-server not reachable — leave the section as-is */
  }
}

function isRunning(app) {
  return !!(app.run && app.run.phase === "running");
}

function render() {
  const section = document.getElementById("foulfox-apps-section");
  const list = document.getElementById("foulfox-apps-list");
  if (!section || !list) return;
  if (!apps.length) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  list.innerHTML = "";
  for (const app of apps) {
    const item = document.createElement("div");
    item.className = "list-item";
    item.id = `foulfox-app-${app.id}`;
    item.title = app.description || app.name;

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("width", "14");
    icon.setAttribute("height", "14");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.style.cssText = "flex-shrink:0;opacity:0.5;";
    icon.innerHTML =
      '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>';
    item.appendChild(icon);

    const label = document.createElement("span");
    label.className = "grow";
    label.textContent = app.name || app.id;
    item.appendChild(label);

    if (isRunning(app)) {
      const dot = document.createElement("span");
      dot.style.cssText =
        "width:6px;height:6px;border-radius:50%;background:#22c55e;flex-shrink:0;";
      dot.title = "Running";
      item.appendChild(dot);
    }

    item.addEventListener("click", () => openApp(app.id));
    list.appendChild(item);
  }
}

function closeOverlay() {
  if (overlay) {
    overlay.remove();
    overlay = null;
    document.removeEventListener("keydown", onKey);
  }
}

function onKey(e) {
  if (e.key === "Escape") closeOverlay();
}

function buildOverlay(app) {
  closeOverlay();
  overlay = document.createElement("div");
  overlay.id = "foulfox-app-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;background:var(--bg,#0b0f0c);";

  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border,#233);flex-shrink:0;";

  const title = document.createElement("span");
  title.textContent = (app.window && app.window.title) || app.name || app.id;
  title.style.cssText = "font-weight:600;font-size:13px;color:var(--fg,#dfe);";
  bar.appendChild(title);

  const status = document.createElement("span");
  status.id = "foulfox-app-overlay-status";
  status.style.cssText =
    "font-size:12px;color:var(--fg-muted,#7a8);margin-left:4px;flex:1;";
  bar.appendChild(status);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Close app");
  closeBtn.style.cssText =
    "background:none;border:none;color:var(--fg,#dfe);cursor:pointer;font-size:15px;padding:4px 8px;";
  closeBtn.addEventListener("click", closeOverlay);
  bar.appendChild(closeBtn);
  overlay.appendChild(bar);

  const body = document.createElement("div");
  body.id = "foulfox-app-overlay-body";
  body.style.cssText = "flex:1;min-height:0;position:relative;";
  overlay.appendChild(body);

  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);
  return { body, status };
}

function mountIframe(body, app) {
  body.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src = appUiSrc(app.id);
  iframe.title = app.name || app.id;
  iframe.style.cssText = "width:100%;height:100%;border:0;display:block;";
  // Same trust model as the shell's Apps tab: allow-same-origin ONLY when the
  // dedicated loopback UI origin exists (appliance); opaque origin in dev.
  iframe.setAttribute(
    "sandbox",
    uiBase
      ? "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
      : "allow-scripts allow-forms allow-downloads allow-popups",
  );
  iframe.setAttribute("allow", "microphone; camera; autoplay; speaker-selection");
  body.appendChild(iframe);
}

async function pollUntilRunning(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(LIST_URL);
      if (res.ok) {
        const data = await res.json();
        apps = (data.apps || []).filter((a) => a && a.status === "installed");
        const app = apps.find((a) => a.id === id);
        if (app && isRunning(app)) {
          render();
          return app;
        }
      }
    } catch {
      /* keep polling */
    }
    if (!overlay) return null; // user closed the window — stop
  }
  return null;
}

async function openApp(id) {
  const app = apps.find((a) => a.id === id);
  if (!app) return;
  const { body, status } = buildOverlay(app);

  if (isRunning(app)) {
    mountIframe(body, app);
    return;
  }

  status.textContent = "Starting…";
  body.innerHTML =
    '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--fg-muted,#7a8);font-size:13px;">Starting app…</div>';
  try {
    const r = await fetch(`${LIST_URL}/${encodeURIComponent(id)}/start`, {
      method: "POST",
    });
    if (!r.ok) {
      let msg = "Could not start the app.";
      try {
        msg = (await r.json()).detail || msg;
      } catch {
        /* keep default */
      }
      status.textContent = "";
      body.innerHTML = "";
      const err = document.createElement("div");
      err.style.cssText =
        "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#e66;font-size:13px;padding:20px;text-align:center;";
      err.textContent = msg; // textContent: server-provided string, never HTML
      body.appendChild(err);
      return;
    }
  } catch {
    status.textContent = "";
    body.innerHTML =
      '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#e66;font-size:13px;">Could not reach the app service.</div>';
    return;
  }

  const started = await pollUntilRunning(id, 90000);
  if (!overlay) return;
  status.textContent = "";
  if (started) {
    mountIframe(body, started);
  } else {
    body.innerHTML =
      '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#e66;font-size:13px;">The app did not become ready. Check the Apps tab for its logs.</div>';
  }
}

fetchApps();
setInterval(fetchApps, REFRESH_MS);
