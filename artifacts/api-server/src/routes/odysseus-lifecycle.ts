import { Router, type IRouter, type Request, type Response } from "express";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import http from "http";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ODYSSEUS_PORT = parseInt(process.env.ODYSSEUS_PORT || "7000", 10);

// Resolve the Odysseus service directory.
// Electron passes ODYSSEUS_DIR explicitly via env. The __dirname-relative
// fallback accounts for the esbuild output landing in dist/ inside api-server:
//   dist/index.mjs (__dirname=dist) → ../.. → artifacts/ → + odysseus-service
const ODYSSEUS_DIR = path.resolve(
  process.env.ODYSSEUS_DIR ||
  path.join(__dirname, "..", "..", "odysseus-service")
);

let odysseusProcess: ChildProcess | null = null;
let odysseusState: "stopped" | "starting" | "running" | "error" = "stopped";

function checkOdysseusAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: ODYSSEUS_PORT, path: "/", method: "GET", timeout: 2000 },
      (res) => { resolve(res.statusCode !== undefined); }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Start Odysseus Python service
router.post("/odysseus/lifecycle/start", async (_req: Request, res: Response) => {
  if (odysseusProcess && odysseusState === "running") {
    const alive = await checkOdysseusAlive();
    if (alive) {
      res.json({ success: false, message: "Odysseus is already running", state: odysseusState });
      return;
    }
  }

  odysseusState = "starting";

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(ODYSSEUS_PORT),
    AUTH_ENABLED: "false",
    ODYSSEUS_DATA_DIR: path.join(ODYSSEUS_DIR, "data"),
    // Route ONLY shell/exec tool calls to this Express API server.
    // Do NOT set ODYSSEUS_INTERNAL_BASE — that would break cookbook/model/state
    // calls which must stay on Odysseus itself.
    ODYSSEUS_SHELL_EXEC_BASE: `http://127.0.0.1:${process.env.PORT ?? "8080"}`,
    // Share the CSRF bridge token so Express accepts Odysseus's internal header.
    ...(process.env.ODYSSEUS_INTERNAL_TOKEN
      ? { ODYSSEUS_BRIDGE_TOKEN: process.env.ODYSSEUS_INTERNAL_TOKEN }
      : {}),
  };

  // Map Replit AI credentials if available
  if (process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
    env.OPENAI_API_KEY = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  }

  try {
    // Try using start.sh first, fall back to direct uvicorn
    const startScript = path.join(ODYSSEUS_DIR, "start.sh");
    const cmd = "bash";
    const args = [startScript];

    odysseusProcess = spawn(cmd, args, {
      cwd: ODYSSEUS_DIR,
      env,
      stdio: "pipe",
      detached: false,
    });

    odysseusProcess.stdout?.on("data", (d: Buffer) => {
      logger.info({ source: "odysseus" }, d.toString().trim());
    });
    odysseusProcess.stderr?.on("data", (d: Buffer) => {
      logger.warn({ source: "odysseus" }, d.toString().trim());
    });

    odysseusProcess.on("error", (err) => {
      logger.error({ err }, "Odysseus process error");
      odysseusState = "error";
      odysseusProcess = null;
    });

    odysseusProcess.on("exit", (code) => {
      logger.info({ code }, "Odysseus process exited");
      odysseusState = "stopped";
      odysseusProcess = null;
    });

    // Poll for readiness (up to 30s)
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const alive = await checkOdysseusAlive();
      if (alive) {
        odysseusState = "running";
        clearInterval(poll);
        logger.info("Odysseus service ready");
      } else if (attempts >= 30) {
        clearInterval(poll);
        if (odysseusState === "starting") {
          odysseusState = "error";
          logger.error("Odysseus service did not become ready in time");
        }
      }
    }, 1000);

    res.json({ success: true, message: "Odysseus starting", state: odysseusState });
  } catch (err) {
    odysseusState = "error";
    logger.error({ err }, "Failed to spawn Odysseus");
    res.json({ success: false, message: `Failed to start Odysseus: ${err instanceof Error ? err.message : String(err)}`, state: odysseusState });
  }
});

// Stop Odysseus Python service
router.post("/odysseus/lifecycle/stop", (_req: Request, res: Response) => {
  if (!odysseusProcess) {
    res.json({ success: false, message: "Odysseus is not running", state: odysseusState });
    return;
  }

  odysseusProcess.kill("SIGTERM");
  setTimeout(() => { if (odysseusProcess) odysseusProcess.kill("SIGKILL"); }, 5000);

  odysseusState = "stopped";
  res.json({ success: true, message: "Odysseus stopping", state: odysseusState });
});

// Get Odysseus lifecycle state
router.get("/odysseus/lifecycle/status", async (_req: Request, res: Response) => {
  const alive = await checkOdysseusAlive();
  if (alive && odysseusState !== "running") odysseusState = "running";
  res.json({ state: odysseusState, pid: odysseusProcess?.pid ?? null, alive });
});

export default router;
