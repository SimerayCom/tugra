import { SetMetadata } from "@nestjs/common";

export const SKIP_IDEMPOTENCY = "skip_idempotency";

/**
 * Opts a POST route out of `Idempotency-Key` replay. The interceptor would otherwise keep the full 2xx response
 * (encrypted) in Redis for 24h and replay it on a retry: wrong for a route whose response carries a one-time secret
 * (rescue root password, console session), which must live in the HTTP response only and must never be replayed stale.
 */
export const SkipIdempotency = () => SetMetadata(SKIP_IDEMPOTENCY, true);
