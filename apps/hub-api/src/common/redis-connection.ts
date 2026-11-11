import Redis, { type RedisOptions } from "ioredis";

/**
 * BullMQ connection options derived from REDIS_URL, parsed by ioredis itself — the same parser
 * RedisService uses via `new Redis(url)`. BullMQ's `connection` option does not accept a URL string
 * (only RedisOptions | Redis | Cluster) and ioredis does not export its URL parser publicly, so we let a
 * throwaway, never-connected (`lazyConnect`) instance parse the URL, read the parsed options, and drop it.
 *
 * This preserves username/password, rediss:// TLS and the /db index — all of which the old hand-rolled
 * `{ host, port }` parsing silently dropped, so every BullMQ queue/worker (monitors, backups, retention,
 * updates, …) broke with NOAUTH / handshake errors, or silently ran on db 0, against an authenticated,
 * TLS or db-indexed Redis. The default in-compose install (redis://redis:6379) parses to the identical
 * options as before, so stock deployments are unchanged.
 */
export function redisConnectionOptions(url: string): RedisOptions {
  // lazyConnect: the constructor only PARSES the URL; no socket is opened. disconnect() on a
  // never-connected instance is a no-op, so this leaves no open handle or reconnect timer behind.
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
  const { host, port, username, password, db, tls } = probe.options;
  probe.disconnect();
  return {
    host,
    port,
    // ioredis gives username "" (or null) for a password-only URL; omit it so AUTH uses the
    // password-only form rather than sending an empty ACL username.
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    db,
    // rediss:// yields tls === true (a boolean) on ioredis 5; BullMQ's typed ConnectionOptions wants an
    // object, and `{}` means "TLS with defaults". A real tls options object (custom CA/servername) is
    // passed through untouched.
    ...(tls ? { tls: typeof tls === "object" ? tls : {} } : {}),
    // BullMQ Worker requires a non-retrying blocking connection.
    maxRetriesPerRequest: null,
  };
}
