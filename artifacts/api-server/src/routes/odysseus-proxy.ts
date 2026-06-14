import { Router, type IRouter, type Request, type Response } from "express";
import http from "http";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ODYSSEUS_PORT = parseInt(process.env.ODYSSEUS_PORT || "7000", 10);

// The Odysseus app is served under this prefix (api-server is mounted at /api,
// this router adds /odysseus). Its HTML/CSS/JS use root-absolute URLs
// (/static/..., /api/...) that would otherwise resolve against the shell origin
// root and 404 inside the embedding iframe. We rewrite responses so everything
// resolves under the proxy prefix instead.
const PROXY_MARKER = "/api/odysseus";

// Runtime shim injected into the Odysseus HTML. It computes the proxy prefix
// from the iframe's own pathname (base-path agnostic) and rewrites root-absolute
// and same-origin-absolute request URLs (fetch / XHR / EventSource) to include
// it. Odysseus sets `API_BASE = window.location.origin`, so its API calls are
// origin-absolute and must be caught here too. Service-worker registration is
// disabled because a worker scoped to a sub-path adds no value inside the embed
// and risks caching proxied 404s.
const RUNTIME_SHIM = `<script>(function(){
  var path = location.pathname;
  var marker = "/api/odysseus";
  var i = path.indexOf(marker);
  var P = i >= 0 ? path.slice(0, i + marker.length) : marker;
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
    try{ W.CONNECTING = ES.CONNECTING; W.OPEN = ES.OPEN; W.CLOSED = ES.CLOSED; }catch(e){}
    window.EventSource = W;
  }
  try{
    if(navigator.serviceWorker && navigator.serviceWorker.register){
      navigator.serviceWorker.register = function(){ return Promise.reject(new Error("sw disabled in embed")); };
    }
  }catch(e){}
})();</script>`;

function rewriteHtml(html: string): string {
  // Strip the leading slash from root-absolute src/href/action so they resolve
  // relative to the document URL (which ends in "/api/odysseus/"). Leaves
  // protocol-relative ("//"), absolute-scheme ("https:", "data:", "tel:") and
  // fragment ("#") references untouched.
  let out = html.replace(/\b(src|href|action)=(["'])\/(?!\/)/gi, "$1=$2");
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${RUNTIME_SHIM}`);
  } else {
    out = RUNTIME_SHIM + out;
  }
  return out;
}

function rewriteCss(css: string, targetPath: string): string {
  // Rewrite root-absolute url(/...) refs to be relative to the stylesheet's own
  // location so they resolve under the proxy prefix. The number of "../" hops
  // equals the stylesheet's directory depth below the prefix.
  const segs = targetPath.split("?")[0].split("/").filter(Boolean);
  const up = "../".repeat(Math.max(segs.length - 1, 0));
  return css.replace(/url\((['"]?)\/(?!\/)/g, (_m, q) => `url(${q}${up}`);
}

// Proxy everything under /api/odysseus/* to the Odysseus service
router.all("/odysseus{/*path}", (req: Request, res: Response) => {
  const targetPath = req.url.replace(/^\/odysseus/, "") || "/";

  // Drop accept-encoding so the upstream returns identity-encoded responses we
  // can safely rewrite (Odysseus enables gzip compression).
  const fwdHeaders = { ...req.headers, host: `127.0.0.1:${ODYSSEUS_PORT}` };
  delete fwdHeaders["accept-encoding"];

  const options: http.RequestOptions = {
    hostname: "127.0.0.1",
    port: ODYSSEUS_PORT,
    path: targetPath,
    method: req.method,
    headers: fwdHeaders,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Pass through response headers (but strip problematic ones for iframe embedding)
    const headers = { ...proxyRes.headers };
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];
    headers["x-frame-options"] = "ALLOWALL";

    const contentType = String(proxyRes.headers["content-type"] || "");
    const isHtml = contentType.includes("text/html");
    const isCss = contentType.includes("text/css");

    if (isHtml || isCss) {
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
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
        logger.error({ err, path: targetPath }, "Odysseus proxy stream error");
        if (!res.headersSent) {
          res.status(502).json({ error: "FoulFox OS service unavailable", details: err.message });
        }
      });
    } else {
      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on("error", (err) => {
    logger.error({ err, path: targetPath }, "Odysseus proxy error");
    if (!res.headersSent) {
      res.status(502).json({ error: "FoulFox OS service unavailable", details: err.message });
    }
  });

  // express.json()/urlencoded() (see app.ts) drain the request stream into
  // req.body for JSON / form content-types. For those we MUST re-serialize the
  // parsed body — piping the already-consumed stream never ends and hangs the
  // upstream forever (e.g. an empty `{}` POST or a no-body DELETE). For all
  // other content-types (multipart uploads, raw, or no body / GET) the stream
  // is untouched, so we pipe it straight through.
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  const streamConsumed =
    ct.includes("application/json") ||
    ct.includes("application/x-www-form-urlencoded");

  if (streamConsumed) {
    let body = "";
    if (req.body && Object.keys(req.body).length > 0) {
      body = ct.includes("application/x-www-form-urlencoded")
        ? new URLSearchParams(req.body as Record<string, string>).toString()
        : JSON.stringify(req.body);
    }
    proxyReq.setHeader(
      "content-type",
      ct.includes("application/x-www-form-urlencoded")
        ? "application/x-www-form-urlencoded"
        : "application/json",
    );
    proxyReq.setHeader("content-length", Buffer.byteLength(body));
    if (body) proxyReq.write(body);
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
    req.resume();
  }
});

// Check if Odysseus is alive
router.get("/odysseus-status", (_req: Request, res: Response) => {
  const options: http.RequestOptions = {
    hostname: "127.0.0.1",
    port: ODYSSEUS_PORT,
    path: "/",
    method: "GET",
    timeout: 2000,
  };

  const check = http.request(options, (checkRes) => {
    res.json({ alive: true, statusCode: checkRes.statusCode });
  });

  check.on("error", () => {
    res.json({ alive: false });
  });

  check.on("timeout", () => {
    check.destroy();
    res.json({ alive: false });
  });

  check.end();
});

export default router;
