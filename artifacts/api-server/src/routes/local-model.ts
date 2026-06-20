import { Router, type IRouter, type Request, type Response } from "express";
import http from "http";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ODYSSEUS_PORT = parseInt(process.env.ODYSSEUS_PORT || "7000", 10);
// The privileged internal token the Odysseus service accepts on admin-gated
// routes. It lives ONLY in this process — never sent to or held by the browser.
// The shell reaches these routes via the X-Shell-Token gate (see app.ts); this
// route then re-authenticates upstream with the internal token on the user's
// behalf so a single-user appliance (no admin login) can still manage endpoints.
const INTERNAL_TOKEN = process.env["ODYSSEUS_INTERNAL_TOKEN"];

type UpstreamResult = { status: number; body: string; contentType: string };

// Forward a request to the Odysseus model-endpoint API with the internal admin
// token injected server-side. `form` is sent as application/x-www-form-urlencoded
// (the FastAPI routes use Form(...) parameters).
function callOdysseus(
  method: string,
  path: string,
  form: Record<string, string> | null,
): Promise<UpstreamResult> {
  return new Promise((resolve, reject) => {
    const payload = form ? new URLSearchParams(form).toString() : "";
    const headers: Record<string, string> = {};
    if (INTERNAL_TOKEN) headers["X-Odysseus-Internal-Token"] = INTERNAL_TOKEN;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: ODYSSEUS_PORT,
        path,
        method,
        headers,
        timeout: 30_000,
      },
      (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c: Buffer) => chunks.push(c));
        resp.on("end", () =>
          resolve({
            status: resp.statusCode || 502,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(resp.headers["content-type"] || "application/json"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("FoulFox OS service request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

// Validate a user-supplied endpoint URL. Defense-in-depth: only http/https, and
// no embedded credentials (those belong in the dedicated secret field). Returns
// an error message, or null when the URL is acceptable.
function validateBaseUrl(raw: string): string | null {
  if (!raw) return "Enter your local model's URL.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That doesn't look like a valid URL — include http:// or https://.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL must start with http:// or https://.";
  }
  if (url.username || url.password) {
    return "Remove the username:password from the URL and use the secret field instead.";
  }
  return null;
}

function relay(res: Response, out: UpstreamResult): void {
  res.status(out.status).type(out.contentType).send(out.body);
}

// GET /api/local-model/endpoints — list configured model endpoints (read-only;
// the service returns key fingerprints, never raw keys).
router.get("/local-model/endpoints", async (_req: Request, res: Response) => {
  try {
    relay(res, await callOdysseus("GET", "/api/model-endpoints", null));
  } catch (err) {
    logger.error({ err }, "local-model list failed");
    res.status(502).json({ error: "FoulFox OS service unavailable" });
  }
});

// POST /api/local-model/test — probe a candidate endpoint without saving it.
router.post("/local-model/test", async (req: Request, res: Response) => {
  const baseUrl = String(req.body?.base_url ?? "").trim();
  const err = validateBaseUrl(baseUrl);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  try {
    relay(
      res,
      await callOdysseus("POST", "/api/model-endpoints/test", {
        base_url: baseUrl,
        api_key: String(req.body?.api_key ?? ""),
        endpoint_kind: String(req.body?.endpoint_kind ?? "auto"),
      }),
    );
  } catch (e) {
    logger.error({ err: e }, "local-model test failed");
    res.status(502).json({ error: "FoulFox OS service unavailable" });
  }
});

// POST /api/local-model/endpoints — persist a new model endpoint.
router.post("/local-model/endpoints", async (req: Request, res: Response) => {
  const baseUrl = String(req.body?.base_url ?? "").trim();
  const err = validateBaseUrl(baseUrl);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  try {
    relay(
      res,
      await callOdysseus("POST", "/api/model-endpoints", {
        name: String(req.body?.name ?? "").trim(),
        base_url: baseUrl,
        api_key: String(req.body?.api_key ?? ""),
        endpoint_kind: String(req.body?.endpoint_kind ?? "auto"),
        supports_tools: String(req.body?.supports_tools ?? ""),
        shared: "true",
      }),
    );
  } catch (e) {
    logger.error({ err: e }, "local-model create failed");
    res.status(502).json({ error: "FoulFox OS service unavailable" });
  }
});

export default router;
