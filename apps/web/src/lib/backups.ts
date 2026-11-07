import type { BackupStatus, RestoreStatus } from "./types";

export function backupColor(s: BackupStatus): string {
  if (s === "SUCCESS") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  return "var(--c-am)";
}

export function restoreColor(s: RestoreStatus): string {
  if (s === "SUCCESS") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  return "var(--c-am)"; // RUNNING
}

/** Human-readable size from a byte count (string from the API's serialized BigInt). */
export function formatSize(bytes: string | null): string {
  if (bytes == null) return "—";
  let n = Number(bytes);
  if (!Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** "—" for unknown, "420 ms" under a second, "42s" under a minute, else "3m 20s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The last non-empty line of a failure's output — the one-line reason shown inline on a FAILED row. */
export function lastErrorLine(errorTail: string | null | undefined): string | null {
  if (!errorTail) return null;
  const lines = errorTail.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}
