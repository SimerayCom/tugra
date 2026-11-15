import { HttpException } from "@nestjs/common";
import { FS_ERROR_CODES, type FsErrorCode } from "@tugra/shared";

/** The agent's closed failure codes mapped to HTTP statuses (see the D1 spec section 4.3). */
const STATUS: Record<FsErrorCode, number> = {
  not_found: 404,
  exists: 409,
  not_dir: 409,
  is_dir: 409,
  not_regular: 409,
  not_empty: 409,
  read_only: 409,
  not_configured: 409,
  not_running: 409,
  no_binary: 409,
  denied: 403,
  changed: 412,
  too_large: 413,
  bad_request: 400,
  unsupported: 501,
  busy: 429,
  expired: 504,
  no_space: 507,
  integrity: 502,
  failed: 502,
};

const KNOWN = new Set<string>(FS_ERROR_CODES);

/** Strip control characters and cap the length: an agent-supplied message is displayed, never trusted. */
export function sanitizeFsMessage(message: unknown): string {
  const s = typeof message === "string" ? message : "";
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
}

/** HTTP status for an agent failure code; anything outside the closed set is a 502. */
export function fsErrorStatus(code: unknown): number {
  return typeof code === "string" && KNOWN.has(code) ? STATUS[code as FsErrorCode] : 502;
}

/**
 * A file operation the AGENT reported as failed. Body `{ statusCode, code, message }` (the global filter adds
 * `error`), so the web can branch on the stable `code`. An unknown or missing code becomes 502 `agent_error`.
 */
export class FsRemoteException extends HttpException {
  readonly code: string;
  constructor(code: unknown, message: unknown) {
    const known = typeof code === "string" && KNOWN.has(code);
    const status = fsErrorStatus(code);
    const c = known ? (code as string) : "agent_error";
    const m = sanitizeFsMessage(message) || "file operation failed";
    super({ statusCode: status, code: c, message: m }, status);
    this.code = c;
  }
}

/** A hub-side policy/limit failure with a stable machine code (`datastore_running`, `deploy_in_progress`, ...). */
export class FsPolicyException extends HttpException {
  readonly code: string;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super({ statusCode: status, code, message, ...extra }, status);
    this.code = code;
  }
}

/** 429 from the per-user mutation limiter; the controller turns `retryAfterSec` into a Retry-After header. */
export class FsRateLimitedException extends FsPolicyException {
  constructor(readonly retryAfterSec: number) {
    super(429, "rate_limited", "too many file changes — slow down", { retryAfterSec });
  }
}
