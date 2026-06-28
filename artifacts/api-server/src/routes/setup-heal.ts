import { Router, type IRouter, type Request, type Response } from "express";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "../lib/logger";

// ── Self-Healing Setup proxy ────────────────────────────────────────────────
// Bridges the shell's first-run wizard to the Odysseus self-heal subsystem:
//   POST /api/setup/heal/repair          autonomously repair FoulFox's own code
//                                         (server-side check_key only) + log it
//   POST /api/setup/heal/event           record a detected error / step result
//   GET  /api/setup/heal/events          list audit events
//   GET  /api/setup/heal/events/download download the complete audit log
// Mounted under /api/setup (localhostOnly + requireStateChangeToken in app.ts),
// so GETs are open to the local shell while POSTs need the X-Shell-Token. This
// route re-authenticates upstream with the internal token on the user's behalf.
// If Odysseus is unreachable, POSTs spool to a local JSONL file so the audit
// log is never lost, and GETs fall back to serving that spool.

const router: IRouter = Router();

const ODYSSEUS_PORT = parseInt(process.env.ODYSSEUS_PORT || "7000", 10);
const INTERNAL_TOKEN = process.env["ODYSSEUS_INTERNAL_TOKEN"];

const SPOOL_DIR = process.env.ODYSSEUS_DATA_DIR || path.join(os.tmpdir(), "foulfox");
const SPOOL_FILE = path.join(SPOOL_DIR, "setup-heal-spool.jsonl");

type UpstreamResult = { status: number; body: string; contentType: string };

// Forward a request to the Odysseus setup-heal API with the internal admin
// token injected server-side. `form` is sent as application/x-www-form-urlencoded
// (the FastAPI routes use Form(...) parameters); pass null for GETs.
function callOdysseus(
  method: string,
  upstreamPath: string,
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
        path: upstreamPath,
        method,
        headers,
        // Repairs run a model + a verification command, so allow a long window.
        timeout: 600_000,
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

function relay(res: Response, out: UpstreamResult): void {
  res.status(out.status).type(out.contentType).send(out.body);
}

// Secret redaction for the outage spool. Odysseus redacts before persisting, but
// the spool path bypasses Odysseus entirely, so we mirror the redaction here —
// the downloadable audit log must never carry credentials, even during outages.
const SECRET_RE: Array<[RegExp, string]> = [
  [/(api[_-]?key["':=\s]*)[A-Za-z0-9._-]{12,}/gi, "$1[REDACTED]"],
  [/(token["':=\s]*)[A-Za-z0-9._-]{12,}/gi, "$1[REDACTED]"],
  [/(password["':=\s]*)\S+/gi, "$1[REDACTED]"],
  [/(bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1[REDACTED]"],
  [/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
];

function redactStr(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_RE) out = out.replace(re, rep);
  return out;
}

function redactObj(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? redactStr(v) : v;
  }
  return out;
}

// Outage spool: persist an event locally when Odysseus can't be reached, so the
// audit trail survives a service crash during the very install meant to fix it.
function spool(obj: Record<string, unknown>): void {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    fs.appendFileSync(
      SPOOL_FILE,
      JSON.stringify({
        ...redactObj(obj),
        created_at: new Date().toISOString(),
        source_service: "api-server-spool",
      }) + "\n",
    );
  } catch (e) {
    logger.error({ err: e }, "setup-heal spool write failed");
  }
}

function readSpool(limit: number): Array<Record<string, unknown>> {
  try {
    const txt = fs.readFileSync(SPOOL_FILE, "utf8");
    const events = txt
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
    return events.slice(-limit).reverse();
  } catch {
    return [];
  }
}

function ctxToString(body: Record<string, unknown> | undefined): string {
  if (body && typeof body["context"] === "object" && body["context"] !== null) {
    return JSON.stringify(body["context"]);
  }
  return String(body?.["context_json"] ?? "");
}

// POST /setup/heal/event — record a detected error / retry / step result.
router.post("/setup/heal/event", async (req: Request, res: Response) => {
  const form: Record<string, string> = {
    event_type: String(req.body?.event_type ?? "info"),
    step: String(req.body?.step ?? ""),
    operation: String(req.body?.operation ?? ""),
    severity: String(req.body?.severity ?? "info"),
    attempt_no: String(req.body?.attempt_no ?? "0"),
    correlation_id: String(req.body?.correlation_id ?? ""),
    error_message: String(req.body?.error_message ?? "").slice(0, 4000),
    context_json: ctxToString(req.body),
  };
  try {
    relay(res, await callOdysseus("POST", "/api/setup-heal/event", form));
  } catch (e) {
    logger.error({ err: e }, "setup-heal event spooled (service down)");
    spool({ kind: "event", ...form });
    res.status(202).json({ ok: true, spooled: true });
  }
});

// POST /setup/heal/repair — autonomously repair FoulFox's own code, then verify.
// SECURITY: the browser may only pick a `check_key`; it can NEVER send a raw
// check_command (the command is resolved from a server-side whitelist upstream).
router.post("/setup/heal/repair", async (req: Request, res: Response) => {
  const objective = String(req.body?.objective ?? "").slice(0, 2000);
  if (!objective) {
    res.status(400).json({ error: "objective is required" });
    return;
  }
  const form: Record<string, string> = {
    objective,
    step: String(req.body?.step ?? ""),
    operation: String(req.body?.operation ?? ""),
    check_key: String(req.body?.check_key ?? "syntax"),
    correlation_id: String(req.body?.correlation_id ?? ""),
    attempt_no: String(req.body?.attempt_no ?? "1"),
    error_message: String(req.body?.error_message ?? "").slice(0, 4000),
    context_json: ctxToString(req.body),
  };
  try {
    relay(res, await callOdysseus("POST", "/api/setup-heal/repair", form));
  } catch (e) {
    logger.error({ err: e }, "setup-heal repair failed (service down)");
    spool({ kind: "repair_unreachable", ...form });
    res.status(502).json({ ok: false, error: "FoulFox OS service unavailable", spooled: true });
  }
});

// GET /setup/heal/events — list audit events (read-only; open to the shell).
router.get("/setup/heal/events", async (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(2000, parseInt(String(req.query.limit ?? "200"), 10) || 200));
  const corr = String(req.query.correlation_id ?? "");
  const qs = new URLSearchParams({ limit: String(limit) });
  if (corr) qs.set("correlation_id", corr);
  try {
    relay(res, await callOdysseus("GET", `/api/setup-heal/events?${qs.toString()}`, null));
  } catch (e) {
    logger.error({ err: e }, "setup-heal events: service down, serving spool");
    res.status(200).json({ events: readSpool(limit), degraded: true });
  }
});

// GET /setup/heal/events/download — download the complete audit log. Always set
// the attachment header here (relay forwards only status/content-type/body), so
// a direct hit downloads a file on both the proxied and spool-fallback paths.
router.get("/setup/heal/events/download", async (_req: Request, res: Response) => {
  res.set("Content-Disposition", 'attachment; filename="foulfox-setup-heal-log.json"');
  try {
    relay(res, await callOdysseus("GET", "/api/setup-heal/events/download", null));
  } catch (e) {
    logger.error({ err: e }, "setup-heal download: service down, serving spool");
    const body = JSON.stringify(
      { service: "foulfox-setup-heal", degraded: true, events: readSpool(100000) },
      null,
      2,
    );
    res
      .status(200)
      .type("application/json")
      .set("Content-Disposition", 'attachment; filename="foulfox-setup-heal-log.json"')
      .send(body);
  }
});

export default router;
