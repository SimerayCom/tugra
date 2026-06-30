import { writableIds } from "./fleet";

/** How many selected items (servers/databases) are writable vs skipped (read-only). */
export function bulkSummary<T extends { id: string; canWrite: boolean }>(items: T[], selected: Set<string>) {
  const writable = writableIds(items, selected).length;
  return { writable, skipped: selected.size - writable };
}
