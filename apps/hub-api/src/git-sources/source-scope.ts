/** Which Git sources a team may use: its own, plus any the instance owner shared with every team. */
export function gitSourcesUsableBy(teamId: string) {
  return { OR: [{ teamId }, { sharedAllTeams: true }] };
}

/** May an app/import in `teamId` use this source? */
export function sourceUsableBy(source: { teamId: string; sharedAllTeams?: boolean | null }, teamId: string): boolean {
  return source.teamId === teamId || source.sharedAllTeams === true;
}
