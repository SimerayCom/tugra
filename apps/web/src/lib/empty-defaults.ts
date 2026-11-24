/** The browser flag that remembers the one-time "Remove empty Default projects?" suggestion was dismissed. */
export const EMPTY_DEFAULTS_DISMISSED_KEY = "tugra.emptyDefaults.dismissed";

export function readEmptyDefaultsDismissed(): boolean {
  try {
    return localStorage.getItem(EMPTY_DEFAULTS_DISMISSED_KEY) === "1";
  } catch {
    return false; // storage unavailable: show the suggestion rather than hide it
  }
}

export function writeEmptyDefaultsDismissed(): void {
  try {
    localStorage.setItem(EMPTY_DEFAULTS_DISMISSED_KEY, "1");
  } catch {
    /* storage unavailable: the suggestion simply shows again next visit */
  }
}
