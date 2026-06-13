import { Router, type IRouter, type Request, type Response } from "express";
import http from "http";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ODYSSEUS_PORT = parseInt(process.env.ODYSSEUS_PORT || "7000", 10);

// Proxy everything under /api/odysseus/* to the Odysseus service
router.all("/odysseus{/*path}", (req: Request, res: Response) => {
  const targetPath = req.url.replace(/^\/odysseus/, "") || "/";

  const options: http.RequestOptions = {
    hostname: "127.0.0.1",
    port: ODYSSEUS_PORT,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${ODYSSEUS_PORT}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Pass through response headers (but strip problematic ones for iframe embedding)
    const headers = { ...proxyRes.headers };
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];
    headers["x-frame-options"] = "ALLOWALL";

    res.writeHead(proxyRes.statusCode || 200, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    logger.error({ err, path: targetPath }, "Odysseus proxy error");
    if (!res.headersSent) {
      res.status(502).json({ error: "Odysseus service unavailable", details: err.message });
    }
  });

  if (req.body && Object.keys(req.body).length > 0) {
    const body = JSON.stringify(req.body);
    proxyReq.setHeader("content-type", "application/json");
    proxyReq.setHeader("content-length", Buffer.byteLength(body));
    proxyReq.write(body);
  } else {
    req.pipe(proxyReq);
    req.resume();
    return;
  }

  proxyReq.end();
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
