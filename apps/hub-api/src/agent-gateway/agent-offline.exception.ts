import { ServiceUnavailableException } from "@nestjs/common";

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
