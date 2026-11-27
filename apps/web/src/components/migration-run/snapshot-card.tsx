"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { formatBytes } from "../../lib/import";
import { Btn, SectionCard, Spinner } from "../ui";
import { Field, Select } from "../form";
import { isTerminalRun } from "../../lib/migration-run";
import { useRunPlumbing } from "./use-run-actions";
import type { MigrationRunView, SnapshotInfo, SnapshotView } from "../../lib/types";

export const snapshotKey = (runId: string) => ["migration-run-snapshot", runId] as const;
const LOCAL = "__local__";
const muted: React.CSSProperties = { fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 };
const NOTE_KEY: Record<string, string> = {
  "nothing-to-copy": "migrationRun.snapshot.note.nothing-to-copy",
  "run-over": "migrationRun.snapshot.note.run-over",
  "no-import": "migrationRun.snapshot.note.no-import",
  "internal-error": "migrationRun.snapshot.note.internal-error",
};
const KIND_KEY = { database: "migrationRun.snapshot.kind.database", volume: "migrationRun.snapshot.kind.volume" } as const;
const ITEM_KEY = { SUCCESS: "migrationRun.snapshot.item.SUCCESS", FAILED: "migrationRun.snapshot.item.FAILED" } as const;

function Warn({ children }: { children: React.ReactNode }) {
  return <div role="note" style={{ fontSize: 12, color: "var(--c-tx2)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "9px 11px", lineHeight: 1.5 }}>{children}</div>;
}

/** Pick where the copy goes: any destination of the team (S3-compatible), or the target's own disk with a warning. */
function Chooser({ view, run, onDone }: { view: SnapshotView; run: MigrationRunView; onDone: (v: SnapshotView) => void }) {
  const t = useT();
  const { onError } = useRunPlumbing(run.id);
  const first = view.destinations.find((d) => d.type === "S3");
  const [choice, setChoice] = useState(view.snapshot?.destinationId ?? first?.id ?? LOCAL);
  const plan = useMutation({ mutationFn: (skip: boolean) => api.planMigrationRunSnapshot(run.id, { destinationId: choice === LOCAL ? null : choice, skip }), onSuccess: onDone, onError });
  const options = [...view.destinations.map((d) => ({ value: d.id, label: d.name })), { value: LOCAL, label: t("migrationRun.snapshot.local") }];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label={t("migrationRun.snapshot.destination")} htmlFor="mr-snap-dest" hint={t("migrationRun.snapshot.hint")}>
        <Select id="mr-snap-dest" value={choice} onChange={setChoice} options={options} ariaLabel={t("migrationRun.snapshot.destination")} />
      </Field>
      {choice === LOCAL && <Warn>{t("migrationRun.snapshot.localWarn")}</Warn>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Btn onClick={() => plan.mutate(false)} disabled={plan.isPending} loading={plan.isPending && plan.variables === false}>{t("migrationRun.snapshot.start")}</Btn>
        <Btn variant="ghost" onClick={() => plan.mutate(true)} disabled={plan.isPending} loading={plan.isPending && plan.variables === true}>{t("migrationRun.snapshot.skip")}</Btn>
        <Link href="/destinations" style={{ color: "var(--c-ac)", fontSize: 13, minHeight: 44, display: "inline-flex", alignItems: "center" }}>{t("migrationRun.snapshot.addDestination")}</Link>
      </div>
    </div>
  );
}

function Items({ run, snap, onDone }: { run: MigrationRunView; snap: SnapshotInfo; onDone: (v: SnapshotView) => void }) {
  const t = useT();
  const { onError, toast } = useRunPlumbing(run.id);
  const [armed, setArmed] = useState<string | null>(null);
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreMigrationRunSnapshot(run.id, id),
    onSuccess: (v) => { setArmed(null); toast(t("migrationRun.snapshot.restoreDone"), "success"); onDone(v); },
    onError,
  });
  return (
    <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {snap.items.map((i) => (
        <li key={`${i.id}-${i.name}`} style={{ listStyle: "none", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere", minWidth: 0 }}>{i.name ?? "—"}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: i.status === "SUCCESS" ? "var(--c-g)" : "var(--c-r)" }}>{t(ITEM_KEY[i.status])}</span>
          </div>
          <div style={muted}>{t(KIND_KEY[i.kind])}{i.sizeBytes ? ` · ${formatBytes(Number(i.sizeBytes))}` : ""}</div>
          {i.error && <div style={{ ...muted, color: "var(--c-r)", overflowWrap: "anywhere" }}>{i.error}</div>}
          {i.status === "SUCCESS" && i.id && snap.status !== "EXPIRED" && (
            armed === i.id ? (
              <div role="alertdialog" aria-label={t("migrationRun.snapshot.goBack")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Warn>{t("migrationRun.snapshot.goBackWarn", { name: i.name ?? "" })}</Warn>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Btn variant="danger" onClick={() => restore.mutate(i.id as string)} loading={restore.isPending}>{t("migrationRun.snapshot.goBackConfirm")}</Btn>
                  <Btn variant="ghost" onClick={() => setArmed(null)}>{t("migrationRun.snapshot.cancel")}</Btn>
                </div>
              </div>
            ) : (
              <div><Btn variant="ghost" onClick={() => setArmed(i.id)}>{t("migrationRun.snapshot.goBack")}</Btn></div>
            )
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The safety copy of a migration (item 93): a copy of the moved data on storage the owner picks, kept 7 days, with a
 * one-click way back per item. It is taken by itself once the data has been copied over, so the owner only decides where
 * it goes (any S3-compatible storage, or the target's own disk, with a warning).
 */
export function SnapshotCard({ run }: { run: MigrationRunView }) {
  const t = useT();
  const qc = useQueryClient();
  const { onError } = useRunPlumbing(run.id);
  const q = useQuery<SnapshotView>({
    queryKey: snapshotKey(run.id),
    queryFn: () => api.getMigrationRunSnapshot(run.id),
    refetchInterval: (query) => ((query.state.data as SnapshotView | undefined)?.snapshot?.status === "CAPTURING" || (query.state.data as SnapshotView | undefined)?.snapshot?.status === "PLANNED" ? 8_000 : false),
  });
  const adopt = (v: SnapshotView) => qc.setQueryData(snapshotKey(run.id), v);
  const now = useMutation({ mutationFn: () => api.captureMigrationRunSnapshot(run.id), onSuccess: adopt, onError });
  const [changing, setChanging] = useState(false);
  const view = q.data;
  const snap = view?.snapshot ?? null;
  const over = isTerminalRun(run.status);
  const where = snap ? (snap.destinationType === "LOCAL" ? t("migrationRun.snapshot.local") : (snap.destinationName ?? "")) : "";
  return (
    <SectionCard title={t("migrationRun.snapshot.title")} desc={t("migrationRun.snapshot.desc", { days: String(snap?.keepDays ?? 7) })} style={{ marginBottom: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {q.isLoading && <Spinner />}
        {q.isError && <div role="alert" style={{ fontSize: 13, color: "var(--c-r)" }}>{t("migrationRun.snapshot.error")}</div>}
        {view && !over && (!snap || changing) && <Chooser view={view} run={run} onDone={(v) => { adopt(v); setChanging(false); }} />}
        {view && over && !snap && <div style={muted}>{t("migrationRun.snapshot.skipped")}</div>}
        {snap && !changing && (
          <>
            <div role="status" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {snap.status === "SKIPPED" && <div style={{ fontSize: 14, fontWeight: 600 }}>{snap.note ? t(NOTE_KEY[snap.note] ?? NOTE_KEY["internal-error"]) : t("migrationRun.snapshot.skipped")}</div>}
              {snap.status === "PLANNED" && (<><div style={{ fontSize: 14, fontWeight: 600 }}>{t("migrationRun.snapshot.reassure")}</div><div style={muted}>{t("migrationRun.snapshot.planned")}</div></>)}
              {snap.status === "CAPTURING" && <div style={{ fontSize: 14, fontWeight: 600 }}>{t("migrationRun.snapshot.capturing")}</div>}
              {snap.status === "SUCCESS" && (<><div style={{ fontSize: 15, fontWeight: 700, color: "var(--c-g)" }}>{t("migrationRun.snapshot.success")}</div><div style={muted}>{t("migrationRun.snapshot.successDesc", { date: snap.expiresAt ? new Date(snap.expiresAt).toLocaleDateString() : "—", where })}</div></>)}
              {snap.status === "PARTIAL" && <div style={{ fontSize: 15, fontWeight: 700, color: "var(--c-am)" }}>{t("migrationRun.snapshot.partial")}</div>}
              {snap.status === "FAILED" && (<><div style={{ fontSize: 15, fontWeight: 700, color: "var(--c-r)" }}>{t("migrationRun.snapshot.failed")}</div>{snap.note && <div style={muted}>{t(NOTE_KEY[snap.note] ?? NOTE_KEY["internal-error"])}</div>}</>)}
              {snap.status === "EXPIRED" && <div style={{ fontSize: 14 }}>{t("migrationRun.snapshot.expired")}</div>}
              {snap.restoredAt && <div style={muted}>{t("migrationRun.snapshot.restored", { date: new Date(snap.restoredAt).toLocaleString() })}</div>}
            </div>
            {snap.destinationType === "LOCAL" && snap.status !== "SKIPPED" && snap.status !== "EXPIRED" && <Warn>{t("migrationRun.snapshot.localWarn")}</Warn>}
            {snap.items.length > 0 && <Items run={run} snap={snap} onDone={adopt} />}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {snap.status === "PLANNED" && <Btn onClick={() => now.mutate()} loading={now.isPending}>{t("migrationRun.snapshot.now")}</Btn>}
              {(snap.status === "PARTIAL" || snap.status === "FAILED") && <Btn onClick={() => now.mutate()} loading={now.isPending}>{t("migrationRun.snapshot.retry")}</Btn>}
              {snap.status === "SKIPPED" && !over && <Btn variant="ghost" onClick={() => setChanging(true)}>{t("migrationRun.snapshot.makeOne")}</Btn>}
              {snap.status === "PLANNED" && !over && <Btn variant="ghost" onClick={() => setChanging(true)}>{t("migrationRun.snapshot.change")}</Btn>}
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}
