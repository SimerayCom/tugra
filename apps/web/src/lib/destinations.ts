import type { BackupDestination, DestType } from "./types";

export function destTypeLabel(t: DestType): string {
  return t === "S3" ? "S3 / R2" : "Local disk";
}

/** Short, human summary of where backups land (bucket + prefix). */
export function destSummary(d: BackupDestination): string {
  if (d.type !== "S3") return "Local disk";
  const path = [d.s3Bucket, d.s3Prefix].filter(Boolean).join("/");
  return `${path}${d.encryptionEnabled ? " · encrypted" : ""}`;
}
