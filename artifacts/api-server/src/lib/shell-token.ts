import { randomBytes } from "crypto";
import { logger } from "./logger";

// Per-process session token for shell endpoints.
// Generated once at startup; all shell exec and WebSocket requests must
// include it via X-Shell-Token header (REST) or ?token= query param (WS).
// This prevents CSRF/localhost attacks from malicious web pages.
export const SHELL_SESSION_TOKEN: string = randomBytes(32).toString("hex");

logger.info("Shell session token generated (required for /api/shell/* access)");
