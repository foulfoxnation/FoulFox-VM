// FoulFox App manifest (foxapp.json) contract + validation.
//
// A "FoulFox App" is an external web app whose GitHub repo carries a foxapp.json
// at its root. The fetch/install subsystem clones the repo, validates this
// manifest, then runs the declared install + build commands. The fully
// normalized manifest is persisted in the registry so the later run/launch phase
// has everything it needs (start argv, healthPath, uiPath, env var names,
// window, capabilities) without re-parsing.
//
// SECURITY: commands are argv arrays executed WITHOUT a shell (no string
// interpolation, no shell metacharacter expansion). Validation here is the first
// gate; the installer adds clone-source allowlisting, timeouts and confinement.

export type AppRuntime = "node" | "python";

// The MVP capability set an app may request; the user approves a subset at
// install time. Enforcement happens in the (out-of-scope) runtime broker.
export const ALLOWED_CAPABILITIES = ["agent.task", "vm.computer_use"] as const;
export type AppCapability = (typeof ALLOWED_CAPABILITIES)[number];

export interface AppWindow {
  title: string;
  width: number;
  height: number;
  singleInstance: boolean;
}

export interface FoxAppManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string | null;
  runtime: AppRuntime;
  install: string[][]; // each entry is an argv array, run without a shell
  build: string[][]; // optional; [] when absent
  start: string[]; // long-running argv; NOT executed during install
  healthPath: string; // begins with "/"
  uiPath: string; // begins with "/"
  portEnv: string; // env var the app reads its port from
  dataEnv: string; // env var the app reads its persistent data dir from
  db: string | null; // informational only
  capabilities: AppCapability[];
  autostart: boolean;
  window: AppWindow;
}

export interface ManifestOk {
  ok: true;
  manifest: FoxAppManifest;
}
export interface ManifestErr {
  ok: false;
  errors: string[];
}
export type ManifestResult = ManifestOk | ManifestErr;

const ID_RE = /^[a-z0-9-]+$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_STEPS = 20;
const MAX_ARGS = 60;
const MAX_ARG_LEN = 4096;

// A single argv array: a non-empty list of non-empty strings within size caps.
function asArgv(value: unknown, label: string, errors: string[]): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array of strings.`);
    return null;
  }
  if (value.length > MAX_ARGS) {
    errors.push(`${label} has too many arguments (max ${MAX_ARGS}).`);
    return null;
  }
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || v.length === 0) {
      errors.push(`${label} must contain only non-empty strings.`);
      return null;
    }
    if (v.length > MAX_ARG_LEN) {
      errors.push(`${label} has an argument that is too long.`);
      return null;
    }
    out.push(v);
  }
  return out;
}

// A list of argv arrays (install/build steps). Missing => no steps.
function asArgvList(value: unknown, label: string, errors: string[]): string[][] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of commands (each an argv array).`);
    return [];
  }
  if (value.length > MAX_STEPS) {
    errors.push(`${label} has too many steps (max ${MAX_STEPS}).`);
    return [];
  }
  const out: string[][] = [];
  value.forEach((step, i) => {
    const argv = asArgv(step, `${label}[${i}]`, errors);
    if (argv) out.push(argv);
  });
  return out;
}

function validPath(value: unknown, def: string, label: string, errors: string[]): string {
  if (value === undefined || value === null) return def;
  if (typeof value !== "string" || !value.startsWith("/")) {
    errors.push(`${label} must be a path starting with "/".`);
    return def;
  }
  return value;
}

function validEnvName(value: unknown, def: string, label: string, errors: string[]): string {
  if (value === undefined || value === null) return def;
  if (typeof value !== "string" || !ENV_RE.test(value)) {
    errors.push(`${label} must be a valid environment variable name (e.g. PORT).`);
    return def;
  }
  return value;
}

function clampDim(v: unknown, def: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  return Math.min(4096, Math.max(200, Math.round(v)));
}

function validWindow(value: unknown, defTitle: string, errors: string[]): AppWindow {
  const d: AppWindow = { title: defTitle, width: 1024, height: 768, singleInstance: true };
  if (value === undefined || value === null) return d;
  if (typeof value !== "object") {
    errors.push("window must be an object.");
    return d;
  }
  const w = value as Record<string, unknown>;
  return {
    title: typeof w.title === "string" && w.title.trim() ? w.title.trim() : d.title,
    width: clampDim(w.width, d.width),
    height: clampDim(w.height, d.height),
    singleInstance: w.singleInstance === undefined ? true : w.singleInstance === true,
  };
}

export function validateManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["foxapp.json must be a JSON object."] };
  }
  const m = raw as Record<string, unknown>;

  if (m.schemaVersion !== 1) errors.push("schemaVersion must be 1.");

  const id = typeof m.id === "string" ? m.id.trim() : "";
  if (!id) errors.push("id is required.");
  else if (!ID_RE.test(id)) {
    errors.push("id must be a slug of lowercase letters, digits and hyphens (^[a-z0-9-]+$).");
  } else if (id.length > 64) errors.push("id is too long (max 64 chars).");

  const name = typeof m.name === "string" ? m.name.trim() : "";
  if (!name) errors.push("name is required.");

  const runtimeRaw = typeof m.runtime === "string" ? m.runtime : "";
  if (runtimeRaw !== "node" && runtimeRaw !== "python") {
    errors.push('runtime must be "node" or "python".');
  }

  const install = asArgvList(m.install, "install", errors);
  const build = asArgvList(m.build, "build", errors);
  const start = asArgv(m.start, "start", errors) ?? [];

  const version = typeof m.version === "string" && m.version.trim() ? m.version.trim() : "0.0.0";
  const description = typeof m.description === "string" ? m.description : "";
  const icon = typeof m.icon === "string" && m.icon.trim() ? m.icon.trim() : null;
  const healthPath = validPath(m.healthPath, "/healthz", "healthPath", errors);
  const uiPath = validPath(m.uiPath, "/", "uiPath", errors);
  const portEnv = validEnvName(m.portEnv, "PORT", "portEnv", errors);
  const dataEnv = validEnvName(m.dataEnv, "FOULFOX_APP_DATA_DIR", "dataEnv", errors);
  const db = typeof m.db === "string" && m.db.trim() ? m.db.trim() : null;
  const autostart = m.autostart === true;

  const capabilities: AppCapability[] = [];
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) {
      errors.push("capabilities must be an array.");
    } else {
      for (const c of m.capabilities) {
        if (typeof c !== "string" || !(ALLOWED_CAPABILITIES as readonly string[]).includes(c)) {
          errors.push(
            `Unsupported capability: ${String(c)}. Allowed: ${ALLOWED_CAPABILITIES.join(", ")}.`,
          );
        } else if (!capabilities.includes(c as AppCapability)) {
          capabilities.push(c as AppCapability);
        }
      }
    }
  }

  const window = validWindow(m.window, name || id || "App", errors);

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      id,
      name,
      version,
      description,
      icon,
      runtime: runtimeRaw as AppRuntime,
      install,
      build,
      start,
      healthPath,
      uiPath,
      portEnv,
      dataEnv,
      db,
      capabilities,
      autostart,
      window,
    },
  };
}
