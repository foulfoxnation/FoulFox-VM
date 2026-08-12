import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// ── Hardware telemetry + first-boot benchmark results ─────────────────────────
// Read-only visibility for the Diagnostics tab: temperatures, memory pressure,
// disk headroom, GPU state, and the benchmark JSON the appliance writes on
// first boot (foulfox-benchmark). Everything degrades gracefully off-appliance.

const router: IRouter = Router();

const DATA_DIR = process.env["ODYSSEUS_DATA_DIR"] || "/var/lib/foulfox";

function readCpuTempC(): number | null {
  // hwmon is the canonical source (k10temp on Ryzen, coretemp on Intel).
  try {
    const base = "/sys/class/hwmon";
    for (const dir of fs.readdirSync(base)) {
      const nameFile = path.join(base, dir, "name");
      let name = "";
      try { name = fs.readFileSync(nameFile, "utf8").trim(); } catch { continue; }
      if (!/k10temp|coretemp|zenpower|cpu_thermal/i.test(name)) continue;
      for (const f of fs.readdirSync(path.join(base, dir))) {
        if (/^temp\d+_input$/.test(f)) {
          const milli = Number(fs.readFileSync(path.join(base, dir, f), "utf8").trim());
          if (Number.isFinite(milli) && milli > 0) return Math.round(milli / 100) / 10;
        }
      }
    }
  } catch { /* not available */ }
  return null;
}

function readGpu(): Promise<{ name: string; tempC: number; vramUsedMb: number; vramTotalMb: number; utilPct: number } | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,temperature.gpu,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout.trim()) { resolve(null); return; }
        const [name, temp, used, total, util] = stdout.trim().split("\n")[0]!.split(",").map((s) => s.trim());
        resolve({
          name: name || "GPU",
          tempC: Number(temp) || 0,
          vramUsedMb: Number(used) || 0,
          vramTotalMb: Number(total) || 0,
          utilPct: Number(util) || 0,
        });
      },
    );
  });
}

router.get("/system/telemetry", async (_req: Request, res: Response) => {
  const total = os.totalmem();
  const free = os.freemem();
  let disk: { totalGb: number; freeGb: number } | null = null;
  try {
    const st = await fs.promises.statfs(fs.existsSync(DATA_DIR) ? DATA_DIR : "/");
    disk = {
      totalGb: Math.round((st.blocks * st.bsize) / 1024 ** 3),
      freeGb: Math.round((st.bavail * st.bsize) / 1024 ** 3),
    };
  } catch { /* unknown */ }
  res.json({
    cpu: {
      cores: os.cpus().length,
      loadAvg1m: Math.round(os.loadavg()[0]! * 100) / 100,
      tempC: readCpuTempC(),
    },
    memory: {
      totalGb: Math.round((total / 1024 ** 3) * 10) / 10,
      usedGb: Math.round(((total - free) / 1024 ** 3) * 10) / 10,
      usedPct: Math.round(((total - free) / total) * 100),
    },
    disk,
    gpu: await readGpu(),
    uptimeSec: Math.round(os.uptime()),
  });
});

router.get("/system/benchmark", (_req: Request, res: Response) => {
  const p = path.join(DATA_DIR, "benchmark.json");
  try {
    res.json({ available: true, ...JSON.parse(fs.readFileSync(p, "utf8")) });
  } catch {
    res.json({ available: false, message: "No benchmark results yet — the appliance runs one automatically on first boot." });
  }
});

export default router;
