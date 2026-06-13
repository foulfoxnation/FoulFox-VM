import { Router, type IRouter } from "express";
import * as fs from "fs/promises";
import * as path from "path";
import {
  ListDirectoryResponse,
  GetStagingResponse,
  ListDrivesResponse,
  FrontloadFilesBody,
  FrontloadFilesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const FRONTLOAD_CATEGORIES = ["drivers", "isos", "files"] as const;
type FrontloadCategory = (typeof FRONTLOAD_CATEGORIES)[number];

// Resolve the frontload staging root. Overridable via env so the OS appliance
// layer can point it at a system path (e.g. /var/lib/foulfox/frontload) that the
// Windows-VM launcher reads. Defaults to a managed dir under the api-server artifact.
function getStagingRoot(): string {
  const override = process.env["FRONTLOAD_STAGING_DIR"];
  if (override && override.length > 0) return path.resolve(override);
  const workspaceRoot = process.cwd().endsWith(path.join("artifacts", "api-server"))
    ? path.resolve(process.cwd(), "../..")
    : process.cwd();
  return path.resolve(workspaceRoot, "artifacts/api-server/data/frontload");
}

interface InternalEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes: number | null;
  modifiedMs: number | null;
}

function normalizeInput(input: string | undefined, fallback: string): string {
  const raw = input && input.length > 0 ? input : fallback;
  if (raw.includes("\0")) throw new Error("Invalid path");
  return path.resolve(raw);
}

async function buildListing(
  target: string,
): Promise<{ path: string; parent: string | null; entries: InternalEntry[] }> {
  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries: InternalEntry[] = await Promise.all(
    dirents.map(async (d) => {
      const full = path.join(target, d.name);
      let type: InternalEntry["type"] = "other";
      if (d.isDirectory()) type = "directory";
      else if (d.isFile()) type = "file";
      else if (d.isSymbolicLink()) type = "symlink";
      let sizeBytes: number | null = null;
      let modifiedMs: number | null = null;
      try {
        const s = await fs.lstat(full);
        sizeBytes = type === "file" ? s.size : null;
        modifiedMs = Math.round(s.mtimeMs);
      } catch {
        /* per-entry stat failures are non-fatal */
      }
      return { name: d.name, path: full, type, sizeBytes, modifiedMs };
    }),
  );
  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, entries };
}

// GET /files/list?path=<dir> — browse the host filesystem (USB mounts, etc.)
router.get("/files/list", async (req, res): Promise<void> => {
  let target: string;
  try {
    target = normalizeInput(
      typeof req.query["path"] === "string" ? (req.query["path"] as string) : undefined,
      process.env["HOME"] || "/",
    );
  } catch {
    res.status(400).json({ error: "Invalid path" });
    return;
  }
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: "Path is not a directory" });
      return;
    }
  } catch {
    res.status(404).json({ error: "Path not found" });
    return;
  }
  try {
    const listing = await buildListing(target);
    res.json(ListDirectoryResponse.parse(listing));
  } catch (err) {
    req.log.warn({ err, target }, "Failed to read directory");
    res.status(403).json({ error: "Cannot read directory" });
  }
});

// GET /files/drives — detect mounted/removable drives (USB sticks, discs)
router.get("/files/drives", async (req, res): Promise<void> => {
  const drives: Array<{
    name: string;
    path: string;
    label: string | null;
    fsType: string | null;
    sizeBytes: number | null;
    removable: boolean;
  }> = [];

  let mounts = "";
  try {
    mounts = await fs.readFile("/proc/mounts", "utf8");
  } catch {
    /* non-linux or unreadable — return empty list (no drives detected) */
  }

  const seen = new Set<string>();
  for (const line of mounts.split("\n")) {
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    const device = parts[0];
    const mountPoint = parts[1]?.replace(/\\040/g, " ");
    const fsType = parts[2];
    if (!device || !mountPoint || !fsType) continue;
    if (!device.startsWith("/dev/")) continue;
    const removable =
      mountPoint.startsWith("/media/") || mountPoint.startsWith("/run/media/");
    const isUserMount = removable || mountPoint.startsWith("/mnt/");
    if (!isUserMount) continue;
    if (seen.has(mountPoint)) continue;
    seen.add(mountPoint);

    let sizeBytes: number | null = null;
    try {
      const statfs = (
        fs as unknown as {
          statfs?: (p: string) => Promise<{ blocks: number; bsize: number }>;
        }
      ).statfs;
      if (statfs) {
        const sf = await statfs(mountPoint);
        sizeBytes = sf.blocks * sf.bsize;
      }
    } catch {
      /* statfs unavailable on this runtime */
    }

    drives.push({
      name: path.basename(mountPoint),
      path: mountPoint,
      label: path.basename(mountPoint),
      fsType,
      sizeBytes,
      removable,
    });
  }

  res.json(ListDrivesResponse.parse(drives));
});

// GET /files/staging — list the frontload staging area (creates it on demand)
router.get("/files/staging", async (req, res): Promise<void> => {
  const stagingRoot = getStagingRoot();
  try {
    await fs.mkdir(stagingRoot, { recursive: true });
    for (const c of FRONTLOAD_CATEGORIES) {
      await fs.mkdir(path.join(stagingRoot, c), { recursive: true });
    }
    const listing = await buildListing(stagingRoot);
    res.json(GetStagingResponse.parse(listing));
  } catch (err) {
    req.log.error({ err, stagingRoot }, "Failed to prepare staging area");
    res.status(500).json({ error: "Failed to prepare staging area" });
  }
});

// POST /files/frontload — copy files/drivers/ISOs from a source (USB) into staging
router.post("/files/frontload", async (req, res): Promise<void> => {
  const parsed = FrontloadFilesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const sources = parsed.data.sources;
  const category: FrontloadCategory =
    (parsed.data.category as FrontloadCategory | undefined) ?? "files";

  const destDir = path.join(getStagingRoot(), category);
  const copied: Array<{ source: string; destination: string }> = [];
  const failed: Array<{ source: string; error: string }> = [];

  try {
    await fs.mkdir(destDir, { recursive: true });
  } catch (err) {
    req.log.error({ err, destDir }, "Failed to create staging directory");
    res.status(500).json({ error: "Failed to create staging directory" });
    return;
  }

  for (const src of sources) {
    try {
      if (src.includes("\0")) throw new Error("Invalid path");
      const absSrc = path.resolve(src);
      const st = await fs.stat(absSrc);
      const dest = path.join(destDir, path.basename(absSrc));
      await fs.cp(absSrc, dest, {
        recursive: st.isDirectory(),
        force: true,
        errorOnExist: false,
      });
      copied.push({ source: absSrc, destination: dest });
    } catch (err) {
      failed.push({
        source: src,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  res.json(FrontloadFilesResponse.parse({ stagingPath: destDir, copied, failed }));
});

export default router;
