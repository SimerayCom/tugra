/** Save-safety logic for the app's HTTP Basic Auth card.
 *
 * The server stores password HASHES and never returns them, and setBasicAuth does a FULL replace: the whole
 * user list is sent each time and an empty list removes all protection. So the card can't pre-fill existing
 * users (no plaintext to show) — every save re-enters every password. That makes two silent-data-loss traps
 * easy to hit, which these helpers close:
 *  - clicking Save on the initial empty form sends [] and silently strips all auth (app goes public);
 *  - a half-typed row (a username with no password, or vice versa) is silently dropped by the filter.
 */

export interface BasicAuthRow {
  user: string;
  password: string;
}

/** The rows that will actually be persisted: trimmed username, both fields present. */
export function completeBasicAuthRows(rows: BasicAuthRow[]): BasicAuthRow[] {
  return rows.map((r) => ({ user: r.user.trim(), password: r.password })).filter((r) => r.user && r.password);
}

/** True when some row has exactly one of {username, password} filled — it would be silently dropped on save. */
export function hasIncompleteBasicAuthRow(rows: BasicAuthRow[]): boolean {
  return rows.some((r) => !!r.user.trim() !== !!r.password);
}

/** Save is allowed only when nothing is half-typed AND there is either a complete row to store or existing
 *  users to remove — never on a pristine empty form (which would be a no-op wipe). */
export function canSaveBasicAuth(rows: BasicAuthRow[], existingCount: number): boolean {
  if (hasIncompleteBasicAuthRow(rows)) return false;
  return completeBasicAuthRows(rows).length > 0 || existingCount > 0;
}

/** True when saving these rows would remove ALL protection (no complete row, but users currently exist).
 *  The card confirms before such a save so the app isn't accidentally made public. */
export function basicAuthSaveRemovesAll(rows: BasicAuthRow[], existingCount: number): boolean {
  return completeBasicAuthRows(rows).length === 0 && existingCount > 0;
}
