/**
 * Localised label for a status enum (app / deploy / server / monitor). The enums are API values
 * (RUNNING, UP…), never copy; the display text lives in the `common.status.*` locale keys. An enum
 * value with no key yet falls back to the raw value, so a new backend status degrades to what the
 * UI showed before instead of printing a key path.
 */
export function statusLabel(t: (key: string) => string, status: string): string {
  const key = `common.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}
