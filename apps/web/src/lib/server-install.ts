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

export type InstallTransport = "pinned" | "plain" | "tls";

/**
 * How the install command reaches the hub, read off the command itself (the hub decides; the UI only explains it):
 * - "pinned": wss:// on a bare IP with the hub's own certificate fingerprint (`--hub-pin`) — encrypted, no domain needed;
 * - "plain" : ws:// (carries the explicit `--hub-insecure` opt-in) — commands are signed, but secrets are readable on the wire;
 * - "tls"   : wss:// with a publicly trusted certificate.
 */
export function installTransport(command: string | null): InstallTransport | null {
  if (!command) return null;
  if (/--hub-insecure(\s|$)/.test(command) || /--hub\s+ws:\/\//.test(command)) return "plain";
  if (/--hub-pin(\s|=)/.test(command)) return "pinned";
  return "tls";
}
