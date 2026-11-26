/** Filter cross-team items to the active team scope (null = all teams). */
export function scopeByTeam<T extends { teamId: string }>(items: T[], teamId: string | null): T[] {
  return teamId ? items.filter((i) => i.teamId === teamId) : items;
}

/** The name of the team the global scope is on, or null when it shows all teams (or the scoped team is not in the list). */
export function scopeTeamName(teams: { id: string; name: string }[], scope: string | null): string | null {
  return scope ? (teams.find((tm) => tm.id === scope)?.name ?? null) : null;
}

/**
 * Seed a create-form's target team from the global scope. The global scope is a
 * *filter* (can be null = all teams), but creating something needs a concrete
 * team — so fall back to the first team when the scope is null or stale.
 */
export function defaultTeamId(scope: string | null, teams: { id: string }[]): string {
  return scope && teams.some((t) => t.id === scope) ? scope : (teams[0]?.id ?? "");
}
