// Default FoulFox Apps: zips bundled into the OS image (or any dir pointed to
// by FOULFOX_DEFAULT_APPS_DIR) are installed automatically on boot, once.
//
// Semantics:
//   - Each zip is seeded AT MOST ONCE per app id (marker file under APPS_DIR).
//     A user who uninstalls a default app is respected — it never comes back
//     on the next boot.
//   - Already-installed ids are skipped (and marked seeded).
//   - After a successful install, apps with autostart:true are started
//     immediately (autostartApps only runs at boot, before seeding finishes).
//   - Failures are logged and retried on the NEXT boot (id only marked seeded
//     after a successful install), so a transient first-boot failure — e.g.
//     no network for npm/pip — heals itself on a later boot.

import { execFile, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { logger } from "./logger";
import { STAGING_DIR, APPS_DIR, getApp } from "./app-registry";
import { startInstallFromZip, getJob } from "./app-installer";
import { startApp } from "./app-runner";

const DEFAULT_DIR = "/usr/share/foulfox/default-apps";
const SEEDED_MARKER = () => path.join(APPS_DIR, ".default-apps-seeded.json");
const INSTALL_POLL_MS = 2000;
const INSTALL_WAIT_MS = 60 * 60 * 1000; // heavy first installs (pip/torch) are slow

function readSeeded(): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(SEEDED_MARKER(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function markSeeded(id: string): void {
  const cur = readSeeded();
  cur[id] = Date.now();
  fs.mkdirSync(APPS_DIR, { recursive: true });
  fs.writeFileSync(SEEDED_MARKER(), JSON.stringify(cur, null, 2));
}

// Read foxapp.json out of the zip without extracting it (root, or inside the
// single top-level folder — same tolerance as the installer).
function manifestFromZip(zipPath: string): Promise<{ id: string; autostart: boolean } | null> {
  return new Promise((resolve) => {
    const tryPattern = (pattern: string, next: () => void) => {
      execFile(
        "unzip",
        ["-p", zipPath, pattern],
        { maxBuffer: 1024 * 1024, timeout: 30_000 },
        (err, stdout) => {
          if (err || !stdout) return next();
          try {
            const m = JSON.parse(stdout);
            const id = typeof m.id === "string" ? m.id : "";
            if (!id) return next();
            resolve({ id, autostart: m.autostart === true });
          } catch {
            next();
          }
        },
      );
    };
    tryPattern("foxapp.json", () =>
      tryPattern("*/foxapp.json", () => resolve(null)),
    );
  });
}

async function waitForJob(jobId: string): Promise<{ ok: boolean; error: string | null }> {
  const deadline = Date.now() + INSTALL_WAIT_MS;
  while (Date.now() < deadline) {
    const job = getJob(jobId);
    if (!job) return { ok: false, error: "install job vanished" };
    if (job.phase === "done") return { ok: true, error: null };
    if (job.phase === "error") return { ok: false, error: job.error };
    await new Promise((r) => setTimeout(r, INSTALL_POLL_MS));
  }
  return { ok: false, error: "install did not finish in time" };
}

async function seedOne(zipPath: string): Promise<void> {
  const meta = await manifestFromZip(zipPath);
  if (!meta) {
    logger.warn({ zipPath }, "default app zip has no readable foxapp.json; skipping");
    return;
  }
  const seeded = readSeeded();
  if (seeded[meta.id]) return; // seeded on an earlier boot (or user uninstalled)
  if (getApp(meta.id)) {
    markSeeded(meta.id); // already present (e.g. installed manually)
    return;
  }

  // The installer DELETES its source zip when done — hand it a copy, never the
  // bundled original (which lives on a read-only squashfs anyway).
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  const tmp = path.join(STAGING_DIR, `default-${crypto.randomBytes(6).toString("hex")}.zip`);
  await new Promise<void>((resolve, reject) => {
    // cp handles large files without buffering in memory.
    const p = spawn("cp", [zipPath, tmp], { stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`cp exited ${c}`))));
  });

  logger.info({ appId: meta.id, zipPath }, "seeding default app");
  const job = startInstallFromZip(tmp, path.basename(zipPath), []);
  const done = await waitForJob(job.jobId);
  if (!done.ok) {
    logger.error({ appId: meta.id, error: done.error }, "default app install failed; will retry next boot");
    return;
  }
  markSeeded(meta.id);
  logger.info({ appId: meta.id }, "default app installed");
  if (meta.autostart) {
    try {
      await startApp(meta.id);
    } catch (err) {
      logger.error({ err, appId: meta.id }, "default app autostart failed");
    }
  }
}

// Fire-and-forget from server boot; installs run sequentially so two heavy
// first-boot installs (npm + pip/torch) don't compete for CPU/network.
export async function seedDefaultApps(): Promise<void> {
  const dir = process.env["FOULFOX_DEFAULT_APPS_DIR"] || DEFAULT_DIR;
  let zips: string[] = [];
  try {
    zips = fs
      .readdirSync(dir)
      .filter((f) => /\.zip$/i.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return; // no default-apps dir on this host (e.g. dev) — nothing to do
  }
  for (const zip of zips) {
    try {
      await seedOne(zip);
    } catch (err) {
      logger.error({ err, zip }, "default app seeding crashed");
    }
  }
}
