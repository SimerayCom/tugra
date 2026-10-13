import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request auth context recorded on every audit entry written during that request. */
export interface AuditCtx {
  via: "pat" | "session";
  tokenId?: string; // the PAT id when via === "pat" (an id, not the secret token)
}

/**
 * Process-global request store. AuditContextInterceptor establishes it (from the resolved req.user) around the
 * route handler, and AuditService.log reads it to stamp how an action was authorized. A plain singleton (not a
 * DI provider) so the interceptor and the service share the exact same AsyncLocalStorage instance.
 */
export const auditContext = new AsyncLocalStorage<AuditCtx>();
