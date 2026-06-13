import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setBaseUrl, setDefaultHeaders } from "@workspace/api-client-react";

// When running inside Electron (production), the UI is loaded via file://
// and cannot use relative /api paths. Set the base URL to the loopback
// API server so all generated hooks resolve to the correct host.
if (window.location.protocol === "file:") {
  setBaseUrl("http://127.0.0.1:8080");
}

// ── Shell session token — attach to every generated API call ─────────────────
// The API server requires X-Shell-Token on all mutating endpoints (shell exec,
// VM start/stop/restart/snapshot, VM config) to prevent loopback CSRF attacks.
// We fetch the token once from the server and then inject it globally via
// setDefaultHeaders so every generated hook (useStartVm, useSnapshotVm, etc.)
// automatically sends it without per-component wiring.
(async () => {
  try {
    const base =
      window.location.protocol === "file:" ? "http://127.0.0.1:8080" : "";
    const res = await fetch(`${base}/api/shell/session-token`);
    if (res.ok) {
      const { token } = (await res.json()) as { token: string };
      if (token) {
        setDefaultHeaders({ "X-Shell-Token": token });
      }
    }
  } catch {
    // Server may not be up yet; token will be absent and protected endpoints
    // will return 401 — the UI surfaces errors via toast on each action.
  }
})();

createRoot(document.getElementById("root")!).render(<App />);
