/** Filter cross-team items to the active team scope (null = all teams). */
export function scopeByTeam<T extends { teamId: string }>(items: T[], teamId: string | null): T[] {
  return teamId ? items.filter((i) => i.teamId === teamId) : items;
}

/**
 * Seed a create-form's target team from the global scope. The global scope is a
 * *filter* (can be null = all teams), but creating something needs a concrete
 * team — so fall back to the first team when the scope is null or stale.
 */
export function defaultTeamId(scope: string | null, teams: { id: string }[]): string {
  return scope && teams.some((t) => t.id === scope) ? scope : (teams[0]?.id ?? "");
}
