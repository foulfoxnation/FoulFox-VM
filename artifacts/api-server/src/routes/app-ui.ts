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

router.all("/:id/ui{/*path}", (req: Request, res: Response) => {
  const id = pathParam(req.params.id);
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
