// FoulFox App broker (spec §5): the ONLY privileged surface an app backend may
// call. Auth = Authorization: Bearer $FOULFOX_APP_TOKEN (per-boot random token
// injected into the app's process env by the runner — never in the browser).
//
// Capability enforcement happens here: an app may use agent.task only if the
// user granted it at install time; everything else → 403. Privilege lives in
// this broker, never in the app process (apps run unprivileged).
//
// agent.task implementation: tasks are forwarded to the Odysseus agent's
// synchronous chat endpoint on the loopback, tracked in an in-memory task map
// so the app can poll. vm.computer_use is deferred (returns 501).

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import { getApp } from "../lib/app-registry";
import { appIdForToken } from "../lib/app-runner";
import type { AppCapability } from "../lib/app-manifest";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ODYSSEUS_PORT = parseInt(process.env.ODYSSEUS_PORT || "7000", 10);
const INTERNAL_TOKEN = process.env["ODYSSEUS_INTERNAL_TOKEN"];

// ── Auth: resolve the bearer token to a running app ──────────────────────────
interface BrokerRequest extends Request {
  brokerAppId?: string;
}

function requireAppToken(req: BrokerRequest, res: Response, next: NextFunction): void {
  const auth = String(req.headers["authorization"] || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const appId = appIdForToken(token);
  if (!appId) {
    res.status(401).json({ error: "Invalid or missing app token." });
    return;
  }
  req.brokerAppId = appId;
  next();
}

function requireCapability(cap: AppCapability) {
  return (req: BrokerRequest, res: Response, next: NextFunction): void => {
    const app = req.brokerAppId ? getApp(req.brokerAppId) : undefined;
    if (!app || !app.grantedCapabilities.includes(cap)) {
      res.status(403).json({ error: `Capability not granted: ${cap}` });
      return;
    }
    next();
  };
}

router.use("/broker", requireAppToken);

// ── agent.task ────────────────────────────────────────────────────────────────
type TaskStatus = "running" | "done" | "error";
interface BrokerTask {
  taskId: string;
  appId: string;
  status: TaskStatus;
  result: unknown;
  error: string | null;
  createdAt: number;
}

const tasks = new Map<string, BrokerTask>();
const TASK_TTL_MS = 30 * 60 * 1000;
const MAX_TASKS = 200;

function pruneTasks(): void {
  const cutoff = Date.now() - TASK_TTL_MS;
  for (const [id, t] of tasks) {
    if (t.createdAt < cutoff) tasks.delete(id);
  }
  while (tasks.size > MAX_TASKS) {
    const oldest = tasks.keys().next().value;
    if (oldest === undefined) break;
    tasks.delete(oldest);
  }
}

async function runAgentTask(task: BrokerTask, prompt: string, context: unknown): Promise<void> {
  try {
    const body = {
      message:
        context !== undefined && context !== null
          ? `${prompt}\n\n[App context]\n${JSON.stringify(context).slice(0, 8000)}`
          : prompt,
    };
    const resp = await fetch(`http://127.0.0.1:${ODYSSEUS_PORT}/api/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INTERNAL_TOKEN ? { "X-Odysseus-Internal-Token": INTERNAL_TOKEN } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Agent returned ${resp.status}: ${text.slice(0, 300)}`);
    }
    const json = (await resp.json()) as { response?: unknown };
    task.status = "done";
    task.result = { response: json.response ?? null };
  } catch (err) {
    task.status = "error";
    task.error = err instanceof Error ? err.message : String(err);
    logger.warn({ appId: task.appId, err: task.error }, "broker agent task failed");
  }
}

// POST /apps/broker/agent/task — submit a natural-language task.
router.post(
  "/broker/agent/task",
  requireCapability("agent.task"),
  (req: BrokerRequest, res: Response) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) {
      res.status(400).json({ error: "A prompt is required." });
      return;
    }
    pruneTasks();
    const task: BrokerTask = {
      taskId: `t_${crypto.randomBytes(8).toString("hex")}`,
      appId: req.brokerAppId!,
      status: "running",
      result: null,
      error: null,
      createdAt: Date.now(),
    };
    tasks.set(task.taskId, task);
    void runAgentTask(task, prompt, req.body?.context);
    res.status(202).json({ taskId: task.taskId, status: task.status });
  },
);

// GET /apps/broker/agent/task/:taskId — poll a task (own tasks only).
router.get(
  "/broker/agent/task/:taskId",
  requireCapability("agent.task"),
  (req: BrokerRequest, res: Response) => {
    const raw = req.params.taskId;
    const taskId = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
    const task = tasks.get(taskId);
    if (!task || task.appId !== req.brokerAppId) {
      res.status(404).json({ error: "Unknown task." });
      return;
    }
    res.json({
      taskId: task.taskId,
      status: task.status,
      ...(task.status === "done" ? { result: task.result } : {}),
      ...(task.status === "error" ? { error: task.error } : {}),
    });
  },
);

// ── vm.computer_use: declared in the spec, deferred in the runtime ───────────
router.post(
  "/broker/vm/:action",
  requireCapability("vm.computer_use"),
  (_req: Request, res: Response) => {
    res.status(501).json({ error: "vm.computer_use is not available yet in this build." });
  },
);

export default router;
