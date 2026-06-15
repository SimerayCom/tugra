import type { ServerView } from "./types";
import { writableIds } from "./fleet";

/** How many of the selected servers will actually run (writable) vs be skipped. */
export function bulkSummary(servers: ServerView[], selected: Set<string>) {
  const writable = writableIds(servers, selected).length;
  return { writable, skipped: selected.size - writable };
}
