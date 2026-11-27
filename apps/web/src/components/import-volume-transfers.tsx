"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "./ui";
import { useToast } from "./toast";
import { useConfirm } from "./confirm";
import { ImportVxPreflight } from "./import-vx-preflight";
import { PHASE_KEY, STATE_KEY, errorKey, formatBytes, formatDuration, transferTone, volumePollMs, volumeProgressPct } from "../lib/import";
import type { OpVolumes, VolumeTransferView } from "../lib/types";

const toneColor: Record<ReturnType<typeof transferTone>, string> = {
  ok: "var(--c-g)",
  warn: "var(--c-am)",
  bad: "var(--c-r)",
  busy: "var(--c-a)",
  muted: "var(--c-tx3)",
};

function VolumeRow({ opId, v }: { opId: string; v: VolumeTransferView }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["import-vx", opId] });
  const fail = (e: unknown) => toast((e as Error).message, "error");
  const name = v.resourceName ?? v.itemRef;
  const done = (key: "abort" | "reset" | "exclude" | "include" | "check") => () => {
    void refresh();
    toast(t(`import.vx.done.${key}`, { name }), "success");
  };
  const abort = useMutation({ mutationFn: () => api.abortOpVolume(opId, v.itemRef), onSuccess: done("abort"), onError: fail });
  const reset = useMutation({ mutationFn: () => api.resetOpVolume(opId, v.itemRef), onSuccess: done("reset"), onError: fail });
  const exclude = useMutation({ mutationFn: () => api.excludeOpVolume(opId, v.itemRef), onSuccess: done("exclude"), onError: fail });
  const include = useMutation({ mutationFn: () => api.includeOpVolume(opId, v.itemRef), onSuccess: done("include"), onError: fail });
  const check = useMutation({ mutationFn: () => api.diskCheckOpVolume(opId, v.itemRef), onSuccess: done("check"), onError: fail });
  // One call at a time per volume: a second button cannot start while another one is still running.
  const working = abort.isPending || reset.isPending || exclude.isPending || include.isPending || check.isPending;

  const pct = volumeProgressPct(v);
  const tone = transferTone(v.state);
  const live = v.state === "COPYING" || v.state === "APPLYING" || v.state === "COPIED";
  const eta = v.state === "COPYING" ? formatDuration(v.etaSec) : null;
  const phaseKey = v.phase ? PHASE_KEY[v.phase] : undefined;
  const ek = errorKey(v.error);
  const canExclude = !v.excluded && (v.state === "NONE" || v.state === "PENDING" || v.state === "FAILED" || v.state === "ABORTED");

  const onAbort = async () => {
    if (await confirm({ title: t("import.vx.confirm.abort.title"), body: t("import.vx.confirm.abort.body"), danger: true })) abort.mutate();
  };
  const onReset = async () => {
    if (await confirm({ title: t("import.vx.confirm.reset.title"), body: t("import.vx.confirm.reset.body"), danger: true })) reset.mutate();
  };
  const onExclude = async () => {
    const ack = { current: false };
    const ok = await confirm({ title: t("import.vx.confirm.exclude.title"), body: t("import.vx.confirm.exclude.body"), danger: true, checkbox: { label: t("import.vx.notMigrated.confirm"), ref: ack } });
    if (ok && ack.current) exclude.mutate();
  };

  return (
    <Card style={{ padding: 14 }} aria-label={t("import.vx.a11y.row", { name })}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <span className="mono" style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-all", flex: "1 1 160px" }}>{name}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{v.mountPath}</span>
        <span data-testid="vx-state" style={{ fontSize: 12, fontWeight: 700, color: toneColor[tone] }}>{t(STATE_KEY[v.state])}</span>
      </div>

      {pct !== null && v.state !== "NONE" && v.state !== "EXCLUDED" && (
        <div
          role="progressbar"
          aria-label={t("import.vx.a11y.progress", { name })}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ height: 8, background: "var(--c-sur)", borderRadius: 4, overflow: "hidden", margin: "10px 0 6px" }}
        >
          <div style={{ width: `${pct}%`, height: "100%", background: v.state === "FAILED" || v.state === "ABORTED" ? "var(--c-r)" : "var(--c-g)", transition: "width .4s" }} />
        </div>
      )}

      {(live || v.state === "DONE" || v.state === "FAILED") && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", fontSize: 12, color: "var(--c-tx3)" }}>
          <span>
            {v.rawBytesTotal
              ? t("import.vx.progress.bytes", { done: formatBytes(v.rawBytesDone), total: formatBytes(v.rawBytesTotal) })
              : t("import.vx.progress.unknownTotal", { done: formatBytes(v.rawBytesDone) })}
          </span>
          <span>{t("import.vx.progress.parts", { count: v.partsDone })}</span>
          {v.state === "COPYING" && v.bps ? <span>{t("import.vx.progress.speed", { rate: formatBytes(v.bps) })}</span> : null}
          {eta && <span>{t("import.vx.progress.eta", { time: eta })}</span>}
          {phaseKey && live && <span style={{ color: "var(--c-tx)" }}>{t(phaseKey)}</span>}
          {v.inventory && <span>{t("import.vx.evidence.reportedByMigrator")}</span>}
        </div>
      )}

      {v.excluded && <p style={{ fontSize: 12, color: "var(--c-am)", margin: "8px 0 0" }}>{v.excluded.reason}</p>}
      {v.error && (
        <p role="alert" style={{ fontSize: 12, color: "var(--c-r)", margin: "8px 0 0" }}>
          {ek ? t(ek) : v.error}
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {v.canAbort && <Btn variant="ghost" onClick={onAbort} disabled={working} loading={abort.isPending}>{t("import.vx.action.abort")}</Btn>}
        {v.canReset && <Btn variant="ghost" onClick={onReset} disabled={working} loading={reset.isPending}>{v.state === "FAILED" ? t("import.vx.action.retry") : t("import.vx.action.reset")}</Btn>}
        {v.state === "NONE" && v.inventory?.found && <Btn variant="ghost" onClick={() => check.mutate()} disabled={working} loading={check.isPending}>{t("import.vx.action.check")}</Btn>}
        {canExclude && <Btn variant="ghost" onClick={onExclude} disabled={working} loading={exclude.isPending}>{t("import.vx.action.exclude")}</Btn>}
        {v.state === "EXCLUDED" && <Btn variant="ghost" onClick={() => include.mutate()} disabled={working} loading={include.isPending}>{t("import.vx.action.include")}</Btn>}
      </div>
    </Card>
  );
}

/** Live per-volume state of the streamed copy. Polls every 3 s while any volume is non-terminal, every 15 s otherwise, and
 *  stops with the component. The inventory the source reported is shown above the rows, labelled as such. */
export function ImportVolumeTransfers({ opId }: { opId: string }) {
  const t = useT();
  const { data, isLoading, refetch, isFetching } = useQuery<OpVolumes>({
    queryKey: ["import-vx", opId],
    queryFn: () => api.getOpVolumes(opId),
    refetchInterval: (q) => volumePollMs((q.state.data as OpVolumes | undefined)?.volumes),
    refetchIntervalInBackground: false,
  });

  if (isLoading) {
    return (
      <Card style={{ padding: 20, maxWidth: 720, marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
        <Spinner /> {t("import.vx.title")}
      </Card>
    );
  }
  if (!data || !data.enabled) return null; // the hub has the streamed copy switched off: nothing to show
  return (
    <Card style={{ padding: 20, maxWidth: 720, marginTop: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ fontWeight: 600, flex: 1 }}>{t("import.vx.title")}</div>
        <Btn variant="ghost" onClick={() => void refetch()} disabled={isFetching}>{t("import.vx.action.refresh")}</Btn>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("import.vx.subtitle")}</p>
      {data.volumes.length === 0 ? (
        <EmptyState>{t("import.vx.empty")}</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ImportVxPreflight volumes={data.volumes.filter((v) => v.inventory || v.gates)} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {data.volumes.map((v) => (
              <VolumeRow key={v.itemRef} opId={opId} v={v} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
