/**
 * Browser vs hub clock skew. Timestamps the hub sends (lastSeenAt, createdAt, ...) are hub time; "how long ago"
 * is computed against the browser clock, so a browser a few seconds behind the hub showed "-1s ago". The skew is
 * measured from the `Date` header of an ordinary API response (no extra request), then added to the browser clock
 * whenever a hub timestamp is compared with "now".
 *
 * Measured once: the first usable sample is kept, and a later one only replaces it when its round trip was
 * shorter (a shorter round trip bounds the error tighter). The header has 1 s resolution, so the sample assumes
 * the middle of that second.
 */
let skewMs = 0;
let bestRttMs = Number.POSITIVE_INFINITY;

/** Add the measured skew to a browser epoch-ms to get the equivalent hub time. */
export function hubNow(browserNowMs: number = Date.now()): number {
  return browserNowMs + skewMs;
}

export function getClockSkewMs(): number {
  return skewMs;
}

/**
 * Feed one response's `Date` header with the browser time when the request started/ended.
 * Responses that may be served from a cache (`Age` header present) are ignored: their Date is stale.
 */
export function observeServerDate(dateHeader: string | null | undefined, sentAtMs: number, receivedAtMs: number, ageHeader?: string | null): boolean {
  if (!dateHeader || ageHeader) return false;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs)) return false;
  const rtt = receivedAtMs - sentAtMs;
  if (!Number.isFinite(rtt) || rtt < 0 || rtt >= bestRttMs) return false;
  bestRttMs = rtt;
  // The Date header is truncated to whole seconds, so the true server time is ~0.5 s later; the response left the
  // server about half a round trip before it was received.
  skewMs = serverMs + 500 - (sentAtMs + rtt / 2);
  return true;
}

/** Test helper: forget any measurement. */
export function resetClockSkew(): void {
  skewMs = 0;
  bestRttMs = Number.POSITIVE_INFINITY;
}
