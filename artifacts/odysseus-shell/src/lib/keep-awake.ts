/**
 * Keep-Awake — prevents the Vite dev preview from going stale ("white page")
 * during long VM sessions inside Replit's constrained browser preview.
 *
 * Why this is needed:
 *  - When a browser tab is backgrounded or left idle, the main thread's timers
 *    are throttled (down to ~once/minute) and the Vite HMR WebSocket can be
 *    closed by the browser. The dev server then loses the client and, on
 *    return, the proxied preview can serve a blank/stale page — discarding
 *    in-page state and any unsaved work.
 *  - During long, mostly-idle sessions the device/screen can also sleep, which
 *    suspends connections and produces the same blank page on resume.
 *
 * What it does (no reloads — unsaved work is never discarded):
 *  1. Runs a heartbeat from a Web Worker (worker timers keep firing while the
 *     tab is hidden, where main-thread timers are throttled) that pings the dev
 *     server so the connection — and the Replit workflow behind it — stays warm.
 *  2. Holds a Screen Wake Lock while the page is visible so the device/screen
 *     does not sleep mid-session, re-acquiring it whenever the tab returns to
 *     the foreground.
 *
 * Scope: dev-only. The packaged Electron build (production, file://) has no
 * Vite dev server to keep warm, so this is a no-op there.
 */

const HEARTBEAT_INTERVAL_MS = 15_000;

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
}

interface WakeLockNavigator {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
}

interface KeepAwakeHandle {
  worker: Worker | null;
  intervalId: number | null;
  wakeLock: WakeLockSentinelLike | null;
  onVisibility: (() => void) | null;
}

declare global {
  interface Window {
    __odysseusKeepAwake?: KeepAwakeHandle | null;
  }
}

export function startKeepAwake(): void {
  if (typeof window === "undefined") return;
  if (!import.meta.env.DEV) return;
  if (window.location.protocol === "file:") return;

  // Tear down any prior instance first. During development a hot-module update
  // can re-run this code; without this we would accumulate a new worker and
  // visibility listener on every update across a long session.
  stopKeepAwake();

  const handle: KeepAwakeHandle = {
    worker: null,
    intervalId: null,
    wakeLock: null,
    onVisibility: null,
  };
  window.__odysseusKeepAwake = handle;

  startHeartbeat(handle);
  startWakeLock(handle);
}

function stopKeepAwake(): void {
  const handle = window.__odysseusKeepAwake;
  if (!handle) return;
  handle.worker?.terminate();
  if (handle.intervalId !== null) window.clearInterval(handle.intervalId);
  if (handle.onVisibility) {
    document.removeEventListener("visibilitychange", handle.onVisibility);
  }
  void handle.wakeLock?.release().catch(() => {});
  window.__odysseusKeepAwake = null;
}

/**
 * Periodically pings the dev server to keep the connection (and the Replit
 * workflow serving it) from idling out. Driven by a Web Worker so the interval
 * keeps firing even when the tab is backgrounded and the main thread is
 * throttled. Falls back to a main-thread interval if Workers are unavailable.
 */
function startHeartbeat(handle: KeepAwakeHandle): void {
  const pingUrl = import.meta.env.BASE_URL || "/";
  const ping = () => {
    fetch(pingUrl, { method: "HEAD", cache: "no-store" }).catch(() => {
      /* transient: server momentarily unreachable — retried on next tick */
    });
  };

  try {
    const workerSrc =
      "let id;onmessage=(e)=>{" +
      "if(e.data==='start'){id=setInterval(()=>postMessage(0)," +
      HEARTBEAT_INTERVAL_MS +
      ");}else{clearInterval(id);}};";
    const blob = new Blob([workerSrc], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = ping;
    worker.postMessage("start");
    handle.worker = worker;
  } catch {
    // Web Worker unavailable — fall back to a main-thread interval. This is
    // throttled in background tabs but still keeps the server warm in the
    // foreground.
    handle.intervalId = window.setInterval(ping, HEARTBEAT_INTERVAL_MS);
  }

  // Fire once immediately so a freshly-restored tab re-establishes contact.
  ping();
}

/**
 * Holds a Screen Wake Lock while the page is visible so the device/screen does
 * not sleep during long sessions. The lock auto-releases when the tab is
 * hidden, so we re-acquire it on every return to the foreground.
 */
function startWakeLock(handle: KeepAwakeHandle): void {
  const nav = navigator as Navigator & WakeLockNavigator;
  if (!nav.wakeLock) return;

  const acquire = async () => {
    if (document.visibilityState !== "visible") return;
    if (handle.wakeLock) return;
    try {
      const sentinel = await nav.wakeLock!.request("screen");
      handle.wakeLock = sentinel;
      sentinel.addEventListener("release", () => {
        handle.wakeLock = null;
      });
    } catch {
      /* the agent may deny the lock (e.g. low battery) — non-fatal */
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") void acquire();
  };
  handle.onVisibility = onVisibility;
  document.addEventListener("visibilitychange", onVisibility);

  void acquire();
}

// Clean up when this module itself is hot-replaced during development.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopKeepAwake());
}
