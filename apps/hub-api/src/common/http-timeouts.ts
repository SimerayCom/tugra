/**
 * Node's HTTP server closes any request that is not fully RECEIVED within `requestTimeout` (300 s by default), which
 * cuts a large file upload on a slow link mid-body. File transfers may legitimately take up to 10 minutes (the agent
 * and the web proxy are sized for that), so allow a little more than that on the hub. `HUB_REQUEST_TIMEOUT_MS`
 * overrides it (0 disables the limit). Never lowers a value that is already higher.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

export function applyTransferTimeouts(server: { requestTimeout?: number }, env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HUB_REQUEST_TIMEOUT_MS);
  const want = env.HUB_REQUEST_TIMEOUT_MS !== undefined && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
  const cur = server.requestTimeout;
  const next = want === 0 ? 0 : cur === 0 ? 0 : Math.max(cur ?? 0, want);
  server.requestTimeout = next;
  return next;
}
