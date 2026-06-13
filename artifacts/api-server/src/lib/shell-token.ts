import { randomBytes } from "crypto";
import { logger } from "./logger";

// Per-process session token for shell endpoints.
// When Electron pre-seeds SHELL_SESSION_TOKEN env var (shared with Odysseus),
// use that; otherwise generate a fresh random token.
// Must be included as X-Shell-Token header (REST) or ?token= query param (WS).
export const SHELL_SESSION_TOKEN: string =
  process.env["SHELL_SESSION_TOKEN"] ?? randomBytes(32).toString("hex");

logger.info("Shell session token ready (required for /api/shell/* access)");
