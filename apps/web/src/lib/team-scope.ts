/** Filter cross-team items to the active team scope (null = all teams). */
export function scopeByTeam<T extends { teamId: string }>(items: T[], teamId: string | null): T[] {
  return teamId ? items.filter((i) => i.teamId === teamId) : items;
}
