/**
 * Tiny, dependency-free `?q` text filter for list endpoints.
 *
 * Applied to ALREADY-AUTHORIZED view objects in memory (never woven into a Prisma `where`), so there is
 * no SQL/query-injection surface — `q` is just a substring tested against plain strings. Callers pass
 * ONLY non-secret fields (name, hostname, image, …) and must NEVER pass a decrypted secret (a password,
 * connection URI, token); otherwise `?q` would become a boolean oracle for probing secret values.
 */

/** Case-insensitive substring match of `q` against any of `fields`. Empty/blank `q` matches everything. */
export function matchesQuery(q: string, fields: Array<string | null | undefined>): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(needle));
}

/**
 * Filter `items` by `q`. When `q` is undefined or blank the array is returned UNCHANGED (so a list with
 * no `?q` behaves exactly as before — a non-breaking addition). `pick` returns the searchable, non-secret
 * fields for one item.
 */
export function filterByQuery<T>(
  items: T[],
  q: unknown,
  pick: (item: T) => Array<string | null | undefined>,
): T[] {
  // `q` comes straight off the query string with no validation pipe, so a client can make it an array
  // (`?q=a&q=b`) or an object (`?q[x]=1`). Treat anything that is not a non-blank string as "no filter"
  // (return the full list) rather than crashing with a 500 on `.trim()`.
  const needle = typeof q === "string" ? q : undefined;
  if (needle === undefined || needle.trim() === "") return items;
  return items.filter((item) => matchesQuery(needle, pick(item)));
}
