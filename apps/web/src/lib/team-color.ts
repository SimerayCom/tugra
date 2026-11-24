const TEAM_COLORS = ["#C9A84C", "#3D6FE5", "#2FBF71", "#E5484D", "#A855F7", "#F5A524"];

/**
 * A team's colour: the one its owner picked (Team.color), else a stable colour from a hash of the id so a team
 * looks the same everywhere before anyone picks one. Always a #rrggbb value (callers append alpha hex digits).
 */
export function teamColor(teamId: string, picked?: string | null): string {
  if (picked && /^#[0-9a-fA-F]{6}$/.test(picked)) return picked;
  let h = 0;
  for (const c of teamId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TEAM_COLORS[h % TEAM_COLORS.length];
}
