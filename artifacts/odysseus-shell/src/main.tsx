import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setBaseUrl } from "@workspace/api-client-react";
import { refreshShellToken } from "./lib/shell-token";
import { startKeepAwake } from "./lib/keep-awake";

// Keep the Vite dev preview from going stale ("white page") during long VM
// sessions — heartbeats the dev server and holds a screen wake lock. No-op in
// the packaged Electron build. See ./lib/keep-awake.ts.
startKeepAwake();

// When running inside Electron (production), the UI is loaded via file://
// and cannot use relative /api paths. Set the base URL to the loopback
// API server so all generated hooks resolve to the correct host.
if (window.location.protocol === "file:") {
  setBaseUrl("http://127.0.0.1:8080");
}

// ── Shell session token — attach to every generated API call ─────────────────
// The API server requires X-Shell-Token on all mutating endpoints (shell exec,
// VM lifecycle, WiFi/Bluetooth, power) to prevent loopback CSRF attacks. The
// shell-token manager fetches it and injects it via setDefaultHeaders for the
// generated hooks; refreshing on an interval keeps it valid across api-server
// restarts ("Retry Setup", live updates), which mint a NEW token each time.
void refreshShellToken();
setInterval(() => void refreshShellToken(), 30_000);

createRoot(document.getElementById("root")!).render(<App />);
