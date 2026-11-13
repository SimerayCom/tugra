import { GatewayTimeoutException, ServiceUnavailableException } from "@nestjs/common";

/**
 * Thrown when an operation needs a connected agent but the server's agent isn't online.
 *
 * Extends {@link ServiceUnavailableException} so an HTTP-reached caller surfaces a clean
 * `503 Service Unavailable` (via {@link ApiExceptionFilter}) with a human message, instead of a
 * plain `Error` masquerading as a `500 Internal server error`. 503 is the correct transient
 * "worker not reachable, retry later" status.
 *
 * It IS-A `Error` and its message keeps the "offline" substring, so schedulers that
 * `.catch(() => undefined)`, runners that record `e.message`, and callers that match on the
 * message are all unaffected — only the surfaced HTTP status changes (500 → 503). Being a subclass
 * of `ServiceUnavailableException` also keeps every existing pre-check site (which already throws
 * `new ServiceUnavailableException("agent offline")`) and its `.toBeInstanceOf` assertions valid.
 */
export class AgentOfflineException extends ServiceUnavailableException {
  constructor(message = "The agent is offline — try again once it reconnects.") {
    super(message);
  }
}

/**
 * Thrown when a connected agent's socket drops WHILE a command/file-op is in flight (the pending request is
 * rejected). Extends {@link ServiceUnavailableException} so an HTTP-reached caller gets a clean `503` with a
 * human message instead of a plain `Error` masked as `500 Internal server error` — a mid-flight drop is a
 * transient "retry later", not a server fault. The message is kept as "agent disconnected" so every existing
 * message-matching caller/spec (and `.catch(() => undefined)` schedulers) is unaffected.
 */
export class AgentDisconnectedException extends ServiceUnavailableException {
  constructor(message = "agent disconnected") {
    super(message);
  }
}

/**
 * Thrown when an agent command (or file op) does not complete within its deadline. Extends
 * {@link GatewayTimeoutException} so an HTTP-reached caller gets a clean `504` with a human message instead of
 * a masked `500`. The message is preserved ("command timed out" / the caller-supplied one) so message-matching
 * callers/specs are unaffected.
 */
export class AgentCommandTimeoutException extends GatewayTimeoutException {
  constructor(message = "command timed out") {
    super(message);
  }
}
