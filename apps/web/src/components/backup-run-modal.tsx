"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useT } from "../i18n/provider";
import { backupColor, formatDuration, formatSize } from "../lib/backups";
import type { BackupStatus } from "../lib/types";
import { Btn } from "./ui";
import { Modal } from "./modal";
import { CopyBtn, CopyRow } from "./copy-row";

/** The slice of a Backup / VolumeBackup row the detail modal needs (both views satisfy it). */
export interface BackupRun {
  id: string;
  status: BackupStatus;
  filename: string;
  volumeName?: string;
  sizeBytes: string | null;
  durationMs: number | null;
  exitCode: number | null;
  errorTail: string | null;
  destinationType: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Run-detail modal for one backup run (database or volume): status, failure reason (the server returns
 * errorTail to writers only — a null tail on a FAILED row means the viewer isn't one), size, duration,
 * destination and a download action. Download reuses the presigned export path (S3 only — a LOCAL backup
 * lives on the server's disk and has no presignable object, so we say so instead of offering a dead button).
 */
export function BackupRunModal({
  run,
  destinationName,
  exportUrl,
  onClose,
}: {
  run: BackupRun;
  /** Resolved destination name; null/undefined = local disk. */
  destinationName?: string | null;
  /** Presigned-download call for this run (S3 backups only). */
  exportUrl: (runId: string) => Promise<{ url: string; expiresAt: string }>;
  onClose: () => void;
}) {
  const t = useT();
  const [link, setLink] = useState<string | null>(null);
  const gen = useMutation({ mutationFn: () => exportUrl(run.id), onSuccess: (r) => setLink(r.url) });
  const failed = run.status === "FAILED";
  const s3 = run.destinationType === "S3";
  const dest = destinationName || (s3 ? "S3" : t("databases.localDisk"));
  const rows: Array<[string, string]> = [
    ...(run.volumeName ? ([[t("databases.runVolume"), run.volumeName]] as Array<[string, string]>) : []),
    [t("databases.runStarted"), new Date(run.createdAt).toLocaleString()],
    [t("databases.runFinished"), run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"],
    [t("databases.runDuration"), formatDuration(run.durationMs)],
    [t("databases.runSize"), formatSize(run.sizeBytes)],
    ...(run.exitCode != null ? ([[t("databases.runExitCode"), String(run.exitCode)]] as Array<[string, string]>) : []),
    [t("databases.runDestination"), dest],
    [t("databases.runFile"), run.filename],
    [t("databases.runTriggeredBy"), run.createdBy === "scheduler" ? t("databases.runScheduler") : run.createdBy],
  ];

  return (
    <Modal onClose={onClose} width={560} ariaLabel={t("databases.runDetailsTitle")}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, flex: 1 }}>{t("databases.runDetailsTitle")}</div>
        <span style={{ fontSize: 12, fontWeight: 700, color: backupColor(run.status) }}>{run.status}</span>
      </div>

      <dl style={{ display: "grid", gridTemplateColumns: "minmax(90px, 140px) 1fr", gap: "6px 12px", margin: "0 0 14px", fontSize: 13 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: "var(--c-tx3)", fontSize: 12 }}>{k}</dt>
            <dd className={k === t("databases.runFile") ? "mono" : undefined} style={{ margin: 0, color: "var(--c-tx2)", wordBreak: "break-all" }}>{v}</dd>
          </div>
        ))}
      </dl>

      {failed && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontSize: 12, color: "var(--c-r)", fontWeight: 700, flex: 1 }}>{t("databases.runFailureReason")}</div>
            {run.errorTail && <CopyBtn text={run.errorTail} />}
          </div>
          {run.errorTail ? (
            <pre
              className="mono"
              style={{ margin: 0, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 10px", color: "var(--c-tx2)" }}
            >
              {run.errorTail}
            </pre>
          ) : (
            <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("databases.runNoReason")}</div>
          )}
        </div>
      )}

      {run.status === "SUCCESS" && (
        <div style={{ marginBottom: 14 }}>
          {s3 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {link ? (
                <>
                  <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("databases.runDownloadReady")}</div>
                  <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-a)", fontSize: 13 }}>{t("databases.runDownloadOpen")}</a>
                  <CopyRow label={t("databases.runDownload")} value={link} copy={t("databases.copy")} secret />
                </>
              ) : (
                <div>
                  <Btn variant="ghost" onClick={() => gen.mutate()} disabled={gen.isPending}>
                    {gen.isPending ? "…" : t("databases.runDownload")}
                  </Btn>
                </div>
              )}
              {gen.isError && <div style={{ color: "var(--c-r)", fontSize: 12 }}>{t("databases.runDownloadFailed")}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("databases.runLocalNote")}</div>
          )}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>{t("databases.runClose")}</Btn>
      </div>
    </Modal>
  );
}
