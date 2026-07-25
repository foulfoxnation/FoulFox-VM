import { authedFetch } from "@/lib/shell-token";

// Open an external link safely from inside the kiosk.
//
// On the FoulFox OS appliance the shell runs inside a --kiosk Chromium, so a
// plain target="_blank" opens ANOTHER fullscreen kiosk window with no header,
// no navigation, and no way back. Instead we ask the api-server to launch the
// decorated overlay browser (foulfox-open-browser) pointed at the URL. In dev
// (or if the launcher is unavailable) we fall back to a normal new tab.
export async function openExternal(url: string): Promise<void> {
  try {
    // /api/browser/open requires the shell session token; authedFetch attaches
    // it and retries once with a fresh one if the server rotated it.
    const r = await authedFetch("/api/browser/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "chromium", url }),
    });
    if (r.ok) return;
  } catch {
    // fall through to the browser fallback
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

// Click handler for anchors: keeps the href for hover/copy-link affordances
// but routes the actual navigation through openExternal.
export function externalLinkClick(url: string) {
  return (e: { preventDefault(): void }) => {
    e.preventDefault();
    void openExternal(url);
  };
}
