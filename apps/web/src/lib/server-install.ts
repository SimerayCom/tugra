/** Onboarding install state for a PENDING server's /servers/[id] view. */

/** After this long without the agent connecting, surface troubleshooting help. */
export const TROUBLESHOOT_MS = 90_000;

export type InstallPhase = "command" | "troubleshoot" | "expired";

/**
 * Which install panel to show while a server is PENDING:
 * - "expired"     → no valid command (enroll token lapsed) → offer a fresh one
 * - "troubleshoot"→ command shown, but it's taking too long → show hints
 * - "command"     → show the command and keep waiting
 */
export function installPhase(installCommand: string | null, waitedMs: number): InstallPhase {
  if (installCommand === null) return "expired";
  if (waitedMs >= TROUBLESHOOT_MS) return "troubleshoot";
  return "command";
}
