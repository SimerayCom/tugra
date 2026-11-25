/**
 * The hub's own Prisma pool settings, applied to a COPY of DATABASE_URL inside the process.
 *
 * Why not rewrite DATABASE_URL in .env: pg_dump (hub backup, pre-update restore point) and `prisma migrate deploy` read the same
 * variable, and libpq rejects Prisma-only URL parameters. Keeping the URL untouched everywhere else and adding the pool
 * parameters only where the Prisma client is built keeps every consumer working.
 *
 * Prisma's default pool is `cpus * 2 + 1` connections with a 10 s wait: 3 connections on a 1 vCPU host, which the ingest, the
 * panel and ~24 BullMQ workers share, so waits end in P2024 timeouts. A profile sets an explicit size (HUB_DB_CONNECTION_LIMIT /
 * HUB_DB_POOL_TIMEOUT, see scripts/lib/profile.sh).
 */

export interface PoolSettings {
  /** Max connections of the Prisma pool; undefined/invalid = leave the URL alone. */
  connectionLimit?: number | string | null;
  /** Seconds a query waits for a free connection; undefined/invalid = leave the URL alone. */
  poolTimeout?: number | string | null;
}

/** A positive integer within [1, max], or undefined (blank, junk, 0, negative, fractional, too large: the setting is ignored, never half-applied). */
export function parsePoolInt(v: number | string | null | undefined, max: number): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!/^\d{1,6}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= max ? n : undefined;
}

/**
 * Append `connection_limit` / `pool_timeout` to a Postgres URL. Respects what is there: an existing query string is extended with
 * `&` (never a second `?`), a parameter the URL already carries is NOT overridden (the operator's explicit URL wins), and a URL
 * that is not parseable as `scheme://...` or has no valid setting to add is returned byte for byte.
 */
export function withPoolParams(url: string, pool: PoolSettings): string {
  const add: string[] = [];
  const limit = parsePoolInt(pool.connectionLimit, 1000);
  const timeout = parsePoolInt(pool.poolTimeout, 3600);
  const hashAt = url.indexOf("#");
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const fragment = hashAt >= 0 ? url.slice(hashAt) : "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return url;
  const qAt = base.indexOf("?");
  const head = qAt >= 0 ? base.slice(0, qAt) : base;
  const query = qAt >= 0 ? base.slice(qAt + 1) : "";
  const have = new Set(query.split("&").map((kv) => kv.split("=")[0]?.toLowerCase()).filter(Boolean));
  if (limit !== undefined && !have.has("connection_limit")) add.push(`connection_limit=${limit}`);
  if (timeout !== undefined && !have.has("pool_timeout")) add.push(`pool_timeout=${timeout}`);
  if (add.length === 0) return url;
  const joined = query.length > 0 ? `${query}${query.endsWith("&") ? "" : "&"}${add.join("&")}` : add.join("&");
  return `${head}?${joined}${fragment}`;
}

/** The URL the hub's PrismaClient connects with (see PrismaService). */
export function hubDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.DATABASE_URL;
  if (!url) return undefined;
  return withPoolParams(url, { connectionLimit: env.HUB_DB_CONNECTION_LIMIT, poolTimeout: env.HUB_DB_POOL_TIMEOUT });
}
