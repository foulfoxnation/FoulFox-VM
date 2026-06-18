import { Router, type IRouter, type Request, type Response } from "express";
import http from "http";
import https from "https";
import dns from "dns";
import net from "net";
import { spawn } from "child_process";
import { promisify } from "util";
import { logger } from "../lib/logger";
import { commandExists, unavailable } from "../lib/peripherals";
import { SHELL_SESSION_TOKEN } from "../lib/shell-token";

const router: IRouter = Router();
const dnsLookupAll = promisify(dns.lookup);

// ── In-shell web browser ──────────────────────────────────────────────────────
// Two cooperating pieces:
//   1. /api/browser/proxy?url=…  — fetches a public web page server-side, strips
//      the X-Frame-Options / CSP headers that block framing, and rewrites the
//      HTML so it renders inside the shell's <iframe>. This is what makes "open
//      the web in a tab" work for the many sites that refuse to be framed.
//   2. /api/browser/launch       — opens the page in fullscreen Chromium on the
//      appliance, for sites the in-frame proxy can't handle (heavy SPAs that
//      need their own origin, logins, media DRM, etc.).
//
// SECURITY MODEL (this proxy is served from the api-server's own origin, so a
// naive design would let a fetched page read the shell session token and call
// the privileged loopback API). Mitigations:
//   • Auth is an HttpOnly, Path=/api/browser/proxy cookie — never in the URL and
//     never readable by the fetched page's scripts; it is also never sent to any
//     other endpoint (those require the X-Shell-Token header, which this cookie
//     is not).
//   • The shell renders the result in a `sandbox`ed iframe WITHOUT
//     allow-same-origin, so the fetched page runs in an opaque origin and cannot
//     touch the shell's storage or make authenticated same-origin API calls.
//   • Navigation is driven by the parent shell via postMessage (the injected
//     script never navigates itself and never sees a token).
//   • SSRF guard: only http/https, DNS-resolve the host and refuse loopback /
//     link-local / private / reserved IPs and the api-server's own ports, and
//     re-validate every redirect hop.

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 12 * 1024 * 1024; // 12 MiB cap on a single fetched doc
const FETCH_TIMEOUT_MS = 20000;
const BROWSER_COOKIE = "ff_browser";

// ── SSRF: block non-public IP literals ────────────────────────────────────────
function ipv4Blocked(ip: string): boolean {
  const parts = ip.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed → block
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.* broadcast
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:1.2.3.4) → evaluate the embedded v4 address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  if (lower.startsWith("ff")) return true; // ff00::/8 multicast
  return false;
}

function ipBlocked(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) return ipv6Blocked(ip);
  return true; // not an IP we understand → block
}

// Validate a candidate URL: scheme + DNS-resolved address must be public.
async function assertSafeUrl(raw: string): Promise<{ url: URL; addresses: string[] } | { error: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "Invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http and https URLs are allowed" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // A bare IP literal is checked directly; a hostname is resolved to all of its
  // addresses and rejected if ANY resolves to a non-public range.
  if (net.isIP(host)) {
    if (ipBlocked(host)) return { error: "Blocked address (private/loopback/reserved)" };
    return { url, addresses: [host] };
  }
  try {
    const addrs = await dnsLookupAll(host, { all: true });
    if (addrs.length === 0) return { error: "Host did not resolve" };
    for (const a of addrs) {
      if (ipBlocked(a.address)) return { error: "Host resolves to a blocked address" };
    }
    return { url, addresses: addrs.map((a) => a.address) };
  } catch {
    return { error: "Host did not resolve" };
  }
}

// ── HTML rewriting ─────────────────────────────────────────────────────────────
// Make sub-resources load from the real origin (via <base>) and route every
// link/GET-form navigation back up to the parent shell (which re-loads it through
// the proxy). The script posts to the parent and never navigates itself, so it
// works inside a same-origin-less sandbox and never handles a token.
const NAV_SHIM = `<script>(function(){
  function abs(u){ try { return new URL(u, document.baseURI).toString(); } catch(e){ return null; } }
  function go(u){ try { window.parent.postMessage({ type: "ff-navigate", url: u }, "*"); } catch(e){} }
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if(!a) return;
    var u = abs(a.getAttribute("href"));
    if(!u || u.indexOf("http") !== 0) return;
    e.preventDefault();
    go(u);
  }, true);
  document.addEventListener("submit", function(e){
    try {
      var f = e.target;
      var method = (f.getAttribute("method") || "get").toLowerCase();
      if(method !== "get") return;
      var u = new URL(f.getAttribute("action") || document.baseURI, document.baseURI);
      var fd = new FormData(f);
      fd.forEach(function(v,k){ if(typeof v === "string") u.searchParams.set(k, v); });
      e.preventDefault();
      go(u.toString());
    } catch(err){}
  }, true);
})();</script>`;

function rewriteHtml(html: string, pageUrl: URL): string {
  const baseHref = pageUrl.toString();
  // Drop any <base> the page shipped so ours wins, then inject ours + the shim
  // at the very start of <head> (before any of the page's own scripts run).
  let out = html.replace(/<base\b[^>]*>/gi, "");
  const inject = `<base href="${baseHref.replace(/"/g, "&quot;")}">${NAV_SHIM}`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, `<html$1>${inject}`);
  } else {
    out = inject + out;
  }
  return out;
}

// ── Upstream fetch with redirect re-validation ────────────────────────────────
interface Upstream {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function fetchOnce(url: URL, addresses: string[]): Promise<{ redirectTo?: string; res?: Upstream; error?: string }> {
  return new Promise((resolve) => {
    const mod = url.protocol === "https:" ? https : http;
    // Pin the socket to an address we already validated, so a hostname can't
    // DNS-rebind to a loopback/private IP between assertSafeUrl() and connect().
    // Node still derives the Host header and TLS SNI from url.hostname.
    const pinnedLookup: net.LookupFunction = (_hostname, options, callback) => {
      const ip = addresses[0];
      const family = net.isIP(ip) === 6 ? 6 : 4;
      if (options && options.all) callback(null, [{ address: ip, family }]);
      else callback(null, ip, family);
    };
    const req = mod.request(
      url,
      {
        method: "GET",
        timeout: FETCH_TIMEOUT_MS,
        lookup: pinnedLookup,
        headers: {
          // Identity encoding so we can rewrite HTML without gunzipping.
          "accept-encoding": "identity",
          "accept": "text/html,application/xhtml+xml,*/*;q=0.8",
          "user-agent": "Mozilla/5.0 (FoulFox OS; in-shell browser) Safari/537.36",
        },
      },
      (upstream) => {
        const status = upstream.statusCode || 502;
        const loc = upstream.headers["location"];
        if (status >= 300 && status < 400 && loc) {
          upstream.resume(); // drain
          resolve({ redirectTo: new URL(loc, url).toString() });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        let aborted = false;
        upstream.on("data", (c: Buffer) => {
          bytes += c.length;
          if (bytes > MAX_BODY_BYTES) {
            aborted = true;
            upstream.destroy();
            return;
          }
          chunks.push(c);
        });
        upstream.on("end", () => {
          if (aborted) { resolve({ error: "Response exceeded size limit" }); return; }
          resolve({ res: { status, headers: upstream.headers, body: Buffer.concat(chunks) } });
        });
        upstream.on("error", (e) => resolve({ error: e.message }));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ error: "Upstream timed out" }); });
    req.on("error", (e) => resolve({ error: e.message }));
    req.end();
  });
}

async function fetchFollowing(start: URL): Promise<{ res?: Upstream; finalUrl?: URL; error?: string }> {
  let current = start;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const safe = await assertSafeUrl(current.toString());
    if ("error" in safe) return { error: safe.error };
    const out = await fetchOnce(safe.url, safe.addresses);
    if (out.error) return { error: out.error };
    // Return the URL that actually produced the body so <base> + the nav-shim
    // resolve relative resources/links against the final (post-redirect) origin.
    if (out.res) return { res: out.res, finalUrl: safe.url };
    if (out.redirectTo) { current = new URL(out.redirectTo); continue; }
    return { error: "Empty upstream response" };
  }
  return { error: "Too many redirects" };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// Hand the shell a Path-scoped, HttpOnly cookie that authorizes ONLY the proxy.
// Called by the shell with the X-Shell-Token header (enforced in app.ts) before
// it loads the browser iframe. The cookie value is the session token, but being
// HttpOnly + path-scoped it is never readable by a fetched page nor sent to any
// other endpoint.
router.post("/browser/session", (req: Request, res: Response) => {
  const secure = req.protocol === "https:";
  res.setHeader(
    "Set-Cookie",
    `${BROWSER_COOKIE}=${SHELL_SESSION_TOKEN}; HttpOnly; Path=/api/browser/proxy; SameSite=Strict; Max-Age=86400${secure ? "; Secure" : ""}`,
  );
  res.json({ ok: true });
});

// Proxy a public web page for in-frame rendering. Auth = the browser cookie.
router.get("/browser/proxy", async (req: Request, res: Response) => {
  const cookie = parseCookie(req.headers["cookie"])[BROWSER_COOKIE];
  if (cookie !== SHELL_SESSION_TOKEN) {
    res.status(401).json({ error: "Browser session not initialized" });
    return;
  }
  const target = typeof req.query["url"] === "string" ? req.query["url"] : "";
  if (!target) { res.status(400).json({ error: "Missing url" }); return; }

  const safe = await assertSafeUrl(target);
  if ("error" in safe) { res.status(400).json({ error: safe.error }); return; }

  const { res: upstream, finalUrl, error } = await fetchFollowing(safe.url);
  if (error || !upstream) {
    res.status(502).type("html").send(errorPage(target, error || "Fetch failed"));
    return;
  }

  // Strip framing/transport headers; never forward Set-Cookie back to the shell.
  const contentType = String(upstream.headers["content-type"] || "");
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;

  if (contentType.includes("text/html")) {
    const body = rewriteHtml(upstream.body.toString("utf8"), finalUrl ?? safe.url);
    headers["content-length"] = String(Buffer.byteLength(body));
    res.writeHead(200, headers);
    res.end(body);
    return;
  }
  headers["content-length"] = String(upstream.body.length);
  res.writeHead(upstream.status, headers);
  res.end(upstream.body);
});

// Launch fullscreen Chromium on the appliance (the in-frame proxy's escape
// hatch). Honest failure in dev (no chromium / no X display).
router.post("/browser/launch", async (req: Request, res: Response) => {
  const target = typeof req.body?.url === "string" ? req.body.url : "";
  if (!target) { res.status(400).json({ error: "Missing url" }); return; }
  const safe = await assertSafeUrl(target);
  if ("error" in safe) { res.status(400).json({ error: safe.error }); return; }

  if (!(await commandExists("chromium"))) {
    res.status(503).json(unavailable("Chromium is not installed (available on the booted FoulFox OS appliance)."));
    return;
  }
  if (!process.env["DISPLAY"]) {
    res.status(503).json(unavailable("No graphical display (available on the booted FoulFox OS appliance)."));
    return;
  }
  try {
    const child = spawn(
      "chromium",
      ["--new-window", "--start-fullscreen", "--no-first-run", "--disable-translate", safe.url.toString()],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    res.json({ ok: true, message: "Opened in Chromium" });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Capability probe for the Browser tab (drives the "open in full browser" affordance).
router.get("/browser/capabilities", async (_req: Request, res: Response) => {
  const chromium = await commandExists("chromium");
  res.json({
    proxy: true, // the in-frame proxy always works
    nativeBrowser: chromium && !!process.env["DISPLAY"],
    chromium,
    hasDisplay: !!process.env["DISPLAY"],
  });
});

function parseCookie(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function errorPage(url: string, detail: string): string {
  const safeUrl = url.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] || c));
  const safeDetail = detail.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] || c));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:system-ui,sans-serif;background:#0c0c0d;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .card{max-width:440px;padding:32px;text-align:center}
    h1{font-size:18px;margin:0 0 8px}p{color:#a1a1aa;font-size:14px;line-height:1.5}code{color:#f87171;word-break:break-all}
  </style></head><body><div class="card"><h1>Couldn't load this page in the tab</h1>
  <p>${safeDetail}</p><p><code>${safeUrl}</code></p>
  <p>Some sites can't be embedded — try "Open in full browser".</p></div></body></html>`;
}

export default router;
