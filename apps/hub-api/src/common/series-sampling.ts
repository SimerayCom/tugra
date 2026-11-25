import { Prisma } from "@prisma/client";

/**
 * Most rows of one series a chart read pulls out of the database before the LTTB down-sampler (1000 points) runs.
 * A 24 h raw host series is 17 280 rows (5 s cadence), a 7-day rollup series 10 080 — and each row carries ~25 columns,
 * so materialising a few of those per request (the metrics tab asks for several ranges at once, from several tabs)
 * cost gigabytes of query-engine and heap memory for a picture that is drawn with 1000 points anyway.
 */
export const PRESAMPLE_ROWS = 3000;

/** Every k-th row such that at most ~PRESAMPLE_ROWS survive, k = ceil(n / PRESAMPLE_ROWS) (1 = keep everything). */
export function strideFor(rows: number, target = PRESAMPLE_ROWS): number {
  return Math.max(1, Math.ceil(rows / target));
}

/** `"a", "b"` — a column list from compile-time constants only (never user input). */
export function columns(names: readonly string[]): Prisma.Sql {
  return Prisma.join(names.map((n) => Prisma.raw(`"${n}"`)));
}

/**
 * Wraps `inner` (a SELECT that must expose the `cols`, ordered by `orderBy`) so only every k-th row of each series comes back,
 * plus always the newest one. `partitionBy` (optional) makes each partition (e.g. each container) its own series with its
 * own k. Stride, not averaging: every returned row is a real stored sample, so values are never invented or biased.
 */
export function strided(inner: Prisma.Sql, cols: readonly string[], orderBy: string, partitionBy?: string): Prisma.Sql {
  const part = partitionBy ? Prisma.raw(`PARTITION BY "${partitionBy}"`) : Prisma.empty;
  const order = Prisma.raw(`"${orderBy}"`);
  return Prisma.sql`
    SELECT ${columns(cols)} FROM (
      SELECT ${columns(cols)},
             row_number() OVER (${part} ORDER BY ${order}) AS "rn",
             count(*) OVER (${part}) AS "n"
      FROM (${inner}) src
    ) t
    WHERE (t."rn" - 1) % GREATEST(1, CEIL(t."n"::float8 / ${PRESAMPLE_ROWS})::bigint) = 0 OR t."rn" = t."n"
    ORDER BY ${order} ASC`;
}
