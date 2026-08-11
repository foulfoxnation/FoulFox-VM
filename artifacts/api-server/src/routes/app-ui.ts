// Reverse proxy for a running FoulFox App's UI: /api/apps/:id/ui/* →
// http://127.0.0.1:<app port>/*. The shell embeds this path in a sandboxed
// iframe, so the app's loopback port and broker token are never exposed.
//
// Mounted in app.ts with localhostOnly ONLY (no shell token): an iframe
// navigation and its subresource requests can't carry custom headers. That is
// safe because the proxy can only reach the app's own loopback server, which
// treats its browser UI as untrusted anyway (the broker token lives exclusively
// in the app's backend env).
//
// Like the Odysseus proxy, HTML/CSS responses are rewritten so root-absolute
// URLs resolve under the proxy prefix, and a runtime shim patches
// fetch/XHR/EventSource/WebSocket URLs the same way.

import { Router, type IRouter, type Request, type Response } from "express";
import http from "http";
import { logger } from "../lib/logger";
import { getApp } from "../lib/app-registry";
import { runningPort } from "../lib/app-runner";

const router: IRouter = Router();

function pathParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

// Runtime shim, parameterized on the per-app proxy prefix (computed from the
// iframe's own pathname so it is base-path agnostic).
function runtimeShim(): string {
  return `<script>(function(){
  var path = location.pathname;
  var m = path.match(/^(.*\\/api\\/apps\\/[^/]+\\/ui)(\\/|$)/);
  var P = m ? m[1] : null;
  if(!P) return;
  // SPA router compat: the app is served under the proxy prefix P, but
  // client-side routers match against location.pathname and would 404 on it.
  // 1) Pin relative URL resolution to the prefix via <base> (survives step 2).
  // 2) Rewrite the visible path to "/" so routers match the app's root route.
  try{
    if(!document.querySelector("base")){
      var b = document.createElement("base");
      b.href = P + "/";
      (document.head || document.documentElement).appendChild(b);
    }
    history.replaceState(history.state, "", "/" + location.search + location.hash);
  }catch(e){}
  function fix(u){
    try{
      if(typeof u !== "string" || !u) return u;
      var o = location.origin;
      if(u.indexOf(o) === 0){
        var rest = u.slice(o.length);
        if(rest === P || rest.indexOf(P + "/") === 0) return u;
        if(rest.charAt(0) === "/") return o + P + rest;
        return u;
      }
      if(u.charAt(0) === "/" && u.charAt(1) !== "/"){
        if(u === P || u.indexOf(P + "/") === 0) return u;
        return P + u;
      }
    }catch(e){}
    return u;
  }
  if(window.fetch){
    var of = window.fetch;
    window.fetch = function(input, init){
      try{
        if(typeof input === "string"){ input = fix(input); }
        else if(input && input.url){ input = new Request(fix(input.url), input); }
      }catch(e){}
      return of.call(this, input, init);
    };
  }
  if(window.XMLHttpRequest){
    var xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(){
      try{ if(arguments.length > 1){ arguments[1] = fix(arguments[1]); } }catch(e){}
      return xo.apply(this, arguments);
    };
  }
  if(window.EventSource){
    var ES = window.EventSource;
    var W = function(u, c){ return new ES(fix(u), c); };
    W.prototype = ES.prototype;
    window.EventSource = W;
  }
  if(window.WebSocket){
    var WS = window.WebSocket;
    var WW = function(u, p){
      try{
        if(typeof u === "string" && u.indexOf("ws") === 0){
          var a = document.createElement("a");
          a.href = u.replace(/^ws/, "http");
          if(a.host === location.host){
            var fixed = fix(a.pathname + a.search);
            u = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + fixed;
          }
        }
      }catch(e){}
      return p === undefined ? new WS(u) : new WS(u, p);
    };
    WW.prototype = WS.prototype;
    try{ WW.CONNECTING = WS.CONNECTING; WW.OPEN = WS.OPEN; WW.CLOSING = WS.CLOSING; WW.CLOSED = WS.CLOSED; }catch(e){}
    window.WebSocket = WW;
  }
  try{
    if(navigator.serviceWorker && navigator.serviceWorker.register){
      navigator.serviceWorker.register = function(){ return Promise.reject(new Error("sw disabled in embed")); };
    }
  }catch(e){}
  // Opaque-sandbox storage polyfill: in dev the shell embeds app UIs WITHOUT
  // allow-same-origin, so any localStorage/sessionStorage touch throws a
  // SecurityError and crashes app JS at boot (blank window). Replace both with
  // in-memory stand-ins when the real ones are inaccessible. State does not
  // persist across reloads — fine for dev; the appliance grants real storage
  // via its dedicated app-UI origin.
  function memStorage(){
    var s = {};
    return {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; },
      setItem: function(k, v){ s[k] = String(v); },
      removeItem: function(k){ delete s[k]; },
      clear: function(){ s = {}; },
      key: function(i){ return Object.keys(s)[i] || null; },
      get length(){ return Object.keys(s).length; }
    };
  }
  function ensureStorage(name){
    try{ window[name].getItem("__probe__"); }
    catch(e){
      try{ Object.defineProperty(window, name, { value: memStorage(), configurable: true }); }catch(e2){}
    }
  }
  ensureStorage("localStorage");
  ensureStorage("sessionStorage");
  // ── FoulFox dialog polyfill ──────────────────────────────────────────────────
  // Chrome 75+ blocks window.prompt / window.confirm / window.alert in
  // cross-origin iframes. FoulFox apps run on a separate loopback origin, making
  // every app iframe cross-origin to the shell. The app bundle is patched to call
  // window._ff_prompt / window._ff_confirm instead of the native blocked versions.
  // These use a native <dialog> element which works fine across all iframe origins.
  function _ffDialog(msg, inputDefault, isConfirm) {
    return new Promise(function(resolve) {
      var d = document.createElement('dialog');
      d.style.cssText = 'z-index:2147483647;padding:24px;border-radius:12px;border:1px solid #444;background:#1c1c1e;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;min-width:320px;max-width:460px;box-shadow:0 8px 40px rgba(0,0,0,.8)';
      var btnLabel = isConfirm ? 'Confirm' : 'OK';
      var html = '<p style="margin:0 0 16px;font-size:14px;font-weight:500;line-height:1.4">' + msg + '</p>';
      if (!isConfirm) { html += '<input id="_ffinp" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:6px;border:1px solid #555;background:#2a2a2e;color:#e8e8e8;font-size:14px" value="' + (inputDefault || '') + '">'; }
      html += '<div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end"><button id="_ffcancel" style="padding:8px 20px;border-radius:6px;border:1px solid #555;background:#2a2a2e;color:#e8e8e8;cursor:pointer;font-size:13px">Cancel</button><button id="_ffok" style="padding:8px 20px;border-radius:6px;border:none;background:#0a84ff;color:#fff;cursor:pointer;font-size:13px;font-weight:600">' + btnLabel + '</button></div>';
      d.innerHTML = html;
      document.body.appendChild(d);
      try { d.showModal(); } catch(e) { document.body.contains(d) && document.body.removeChild(d); resolve(null); return; }
      var inp = d.querySelector('#_ffinp');
      if (inp) { inp.focus(); inp.select(); }
      function ok() { var v = inp ? inp.value : true; try { d.close(); } catch(e) {} document.body.contains(d) && document.body.removeChild(d); resolve(isConfirm ? true : (v || null)); }
      function cancel() { try { d.close(); } catch(e) {} document.body.contains(d) && document.body.removeChild(d); resolve(null); }
      d.querySelector('#_ffok').onclick = ok;
      d.querySelector('#_ffcancel').onclick = cancel;
      d.addEventListener('cancel', cancel);
      if (inp) { inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') ok(); if (e.key === 'Escape') cancel(); }); }
    });
  }
  window._ff_prompt = function(msg, def) { return _ffDialog(msg, def, false); };
  window._ff_confirm = function(msg) { return _ffDialog(msg, null, true).then(function(v) { return v !== null; }); };
})();</script>`;
}

function rewriteHtml(html: string): string {
  let out = html.replace(/\b(src|href|action)=(["'])\/(?!\/)/gi, "$1=$2");
  const shim = runtimeShim();
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${shim}`);
  } else {
    out = shim + out;
  }
  return out;
}

function rewriteCss(css: string, targetPath: string): string {
  const segs = targetPath.split("?")[0].split("/").filter(Boolean);
  const up = "../".repeat(Math.max(segs.length - 1, 0));
  return css.replace(/url\((['"]?)\/(?!\/)/g, (_m, q) => `url(${q}${up}`);
}

// Foreign-Origin write rejection (CSRF hardening): browsers attach an Origin
// header to every cross-origin non-GET request. Legitimate writes into an app
// backend come only from loopback origins (the dedicated app-UI origin on the
// appliance, or the shell/Vite origin in dev) — or from the dev shell's
// opaque-sandboxed iframe, which sends "null" but ONLY exists when the
// dedicated origin is off. Any real web origin (https://evil.example) is
// refused before a byte reaches the app.
const APP_UI_SEPARATE_ORIGIN = !!process.env["SERVE_SHELL_STATIC"];

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser callers (curl, native) send no Origin
  if (origin === "null") return !APP_UI_SEPARATE_ORIGIN; // dev opaque iframe only
  try {
    const u = new URL(origin);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1") {
      return true;
    }
    // Dev only: the Replit preview serves the shell from its own https origin.
    if (!APP_UI_SEPARATE_ORIGIN && process.env["REPLIT_DEV_DOMAIN"]) {
      if (u.hostname === process.env["REPLIT_DEV_DOMAIN"]) return true;
    }
  } catch {
    return false;
  }
  return false;
}

router.all("/:id/ui{/*path}", (req: Request, res: Response) => {
  const id = pathParam(req.params.id);
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      logger.warn({ id, origin, method: req.method }, "app ui proxy: foreign-origin write refused");
      res.status(403).json({ error: "Cross-origin writes into app backends are not allowed." });
      return;
    }
  }
  const app = getApp(id);
  if (!app) {
    res.status(404).json({ error: "No such app." });
    return;
  }
  const port = runningPort(id);
  if (!port) {
    res.status(503).json({ error: "App is not running." });
    return;
  }

  // Path after the /:id/ui prefix (req.url is relative to the mount point).
  const targetPath = req.url.replace(new RegExp(`^/${id}/ui`), "") || "/";

  const fwdHeaders = { ...req.headers, host: `127.0.0.1:${port}` };
  delete fwdHeaders["accept-encoding"];
  // Never let the upstream answer 304 for documents: the browser's cached
  // copy may carry a stale injected shim. Drop conditional headers so we
  // always receive a full body to rewrite. (Assets are content-hashed, so
  // losing conditional GETs there is harmless.)
  delete fwdHeaders["if-none-match"];
  delete fwdHeaders["if-modified-since"];
  // Strip the browser's Origin header before forwarding to the app process.
  // The browser sends the shell's origin (e.g. http://localhost:8080) when
  // loading <script type="module" crossorigin> assets; app servers running in
  // AUTH_MODE=local reject any origin not on their own loopback port (→ 403).
  // CSRF protection for writes is already enforced above by originAllowed(),
  // so removing Origin from the upstream request is safe.
  delete fwdHeaders["origin"];

  const proxyReq = http.request(
    { hostname: "127.0.0.1", port, path: targetPath, method: req.method, headers: fwdHeaders },
    (proxyRes) => {
      const headers = { ...proxyRes.headers };
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];

      const contentType = String(proxyRes.headers["content-type"] || "");
      const isHtml = contentType.includes("text/html");
      const isCss = contentType.includes("text/css");

      if (isHtml || isCss) {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (c: Buffer) => chunks.push(c));
        proxyRes.on("end", () => {
          let body = Buffer.concat(chunks).toString("utf8");
          body = isHtml ? rewriteHtml(body) : rewriteCss(body, targetPath);
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          if (isHtml) {
            delete headers["etag"];
            delete headers["last-modified"];
            headers["cache-control"] = "no-store";
          }
          headers["content-length"] = String(Buffer.byteLength(body));
          res.writeHead(proxyRes.statusCode || 200, headers);
          res.end(body);
        });
        proxyRes.on("error", (err) => {
          logger.error({ err, id, path: targetPath }, "app ui proxy stream error");
          if (!res.headersSent) res.status(502).json({ error: "App stream error" });
        });
      } else {
        res.writeHead(proxyRes.statusCode || 200, headers);
        proxyRes.pipe(res);
      }
    },
  );

  proxyReq.on("error", (err) => {
    logger.warn({ err: err.message, id, path: targetPath }, "app ui proxy error");
    if (!res.headersSent) res.status(502).json({ error: "App is not responding." });
  });

  // Mounted BEFORE express.json() in app.ts, so the request stream is intact —
  // pipe every method straight through (uploads, JSON posts, everything).
  if (req.method === "GET" || req.method === "HEAD") proxyReq.end();
  else req.pipe(proxyReq);
});

export default router;
