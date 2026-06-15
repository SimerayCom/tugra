import type { BackupStatus } from "./types";

export function backupColor(s: BackupStatus): string {
  if (s === "SUCCESS") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  return "var(--c-am)";
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
