import type { ServerView } from "./types";

/** The placeholder the hub stores for a server added without a name (it is replaced by the host's real hostname
 *  once the agent connects). Mirrors UNNAMED_SERVER in the hub's servers service. */
export const UNNAMED_SERVER_PLACEHOLDER = "New server";

/** The name to show: the stored one, or a localized label while an auto-named server has not connected yet. */
export function serverDisplayName(s: Pick<ServerView, "name"> & Partial<Pick<ServerView, "nameAuto">>, t: (key: string) => string): string {
  return s.nameAuto && s.name === UNNAMED_SERVER_PLACEHOLDER ? t("servers.unnamed") : s.name;
}
