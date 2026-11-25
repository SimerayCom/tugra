"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectMoveView } from "@tugra/shared";
import { api, type ProjectMovePreviewView } from "../lib/api";
import { useT } from "../i18n/provider";
import { blockersOf, moveCanCancel, moveErrorKey, moveHasSafetyCopy, moveIsActive, parseWarning, targetServers } from "../lib/project-server-move";
import { formatDateTime } from "../lib/format-time";
import { Badge, Btn, SectionCard } from "./ui";
import { Checkbox, Select } from "./form";
import { useConfirm } from "./confirm";

const PHASE_TONE = { QUEUED: "muted", PRECHECK: "lapis", MOVING: "lapis", VERIFYING: "lapis", CUTOVER: "lapis", COMPLETED: "ok", ROLLING_BACK: "warn", ROLLED_BACK: "muted", FAILED: "danger" } as const;
const li: React.CSSProperties = { borderTop: "1px solid var(--c-bd)", padding: "8px 0", display: "flex", gap: "4px 10px", flexWrap: "wrap", alignItems: "center", minWidth: 0, fontSize: 13 };
const dim: React.CSSProperties = { fontSize: 12, color: "var(--c-tx3)", overflowWrap: "anywhere" };
const note = (color: string): React.CSSProperties => ({ margin: "8px 0 0", fontSize: 12.5, color });

function Blockers({ blockers }: { blockers: ProjectMovePreviewView["blockers"] }) {
  const t = useT();
  return (
    <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }} role="alert">
      {blockers.map((b, i) => (
        <li key={`${b.code}:${b.ref ?? ""}:${i}`} style={{ ...li, color: "var(--c-r)" }}>
          {b.ref && <strong>{b.ref}</strong>}
          <span>{t(`projectMove.blocker.${b.code}`, { codes: (b.codes ?? []).join(", ") })}</span>
        </li>
      ))}
    </ul>
  );
}

function Progress({ move }: { move: ProjectMoveView }) {
  const t = useT();
  const warnings = move.report?.warnings ?? [];
  return (
    <div data-testid="project-move-progress">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Badge tone={PHASE_TONE[move.phase]}>{t(`projectMove.phase.${move.phase}`)}</Badge>
        {move.failureCode && <span role="alert" style={{ color: "var(--c-r)", fontSize: 12.5 }}>{t(`projectMove.failure.${move.failureCode}`)}</span>}
      </div>
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
        {move.items.map((i) => (
          <li key={`${i.kind}:${i.refId}`} style={li}>
            <Badge tone="muted">{t(`projectMove.item.${i.kind}`)}</Badge>
            <strong>{i.name}</strong>
            <Badge tone={i.phase === "moved" ? "ok" : "muted"}>{t(`projectMove.itemPhase.${i.phase}`)}</Badge>
            {i.tempAddress && <span className="mono" style={dim}>{t("projectMove.tempAddress", { address: i.tempAddress })}</span>}
          </li>
        ))}
      </ul>
      {move.report && (
        <>
          <h4 style={{ margin: "14px 0 4px", fontSize: 13 }}>{t("projectMove.report.title")}</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {move.report.checks.map((c, idx) => (
              <li key={`${c.code}:${c.itemRef}:${idx}`} style={li}>
                <Badge tone={c.ok ? "ok" : "danger"}>{c.ok ? "OK" : "!"}</Badge>
                <span>{t(`projectMove.check.${c.code}`)}</span>
                <strong>{c.name}</strong>
              </li>
            ))}
          </ul>
          {move.report.dns.length > 0 && (
            <>
              <h4 style={{ margin: "14px 0 4px", fontSize: 13 }}>{t("projectMove.report.dnsTitle")}</h4>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {move.report.dns.map((d) => (
                  <li key={d.hostname} style={li} className="mono">
                    {d.targetIp ? t(d.repointed ? "projectMove.report.dnsDone" : "projectMove.report.dnsPending", { host: d.hostname, ip: d.targetIp }) : t("projectMove.report.dnsNoIp", { host: d.hostname })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {warnings.length > 0 && (
            <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
              {warnings.map((w) => {
                const p = parseWarning(w);
                return <li key={w} style={dim}>{t(`projectMove.warning.${p.code}`, { ref: p.ref ?? "" })}</li>;
              })}
            </ul>
          )}
        </>
      )}
      {moveHasSafetyCopy(move) && move.archiveUntil && <p style={note("var(--c-tx3)")}>{t("projectMove.safety", { date: formatDateTime(move.archiveUntil) })}</p>}
    </div>
  );
}

/**
 * Move a project and everything under it to another server (owner only; the hub enforces it). The preview changes nothing and lists what
 * stops the move; starting needs the project's name typed; progress, the verification report and the DNS steps follow the stored move.
 */
export function ProjectMovePanel({ projectId, projectName, teamId, excludeServerNames }: { projectId: string; projectName: string; teamId: string; excludeServerNames: string[] }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [repointDns, setRepointDns] = useState(false);
  const [retainDays, setRetainDays] = useState(7);
  const [startBlockers, setStartBlockers] = useState<ProjectMovePreviewView["blockers"] | null>(null);

  const servers = useQuery({ queryKey: ["servers", "team", teamId], queryFn: () => api.listServers({ teamId }), enabled: open });
  const moves = useQuery({
    queryKey: ["project-moves", projectId],
    queryFn: () => api.projectMoveList(projectId),
    refetchInterval: (q) => (moveIsActive(q.state.data?.[0]) ? 3000 : false),
  });
  const last = moves.data?.[0] ?? null;
  const body = { projectId, targetServerId: target, acknowledge: {} };
  const preview = useMutation({ mutationFn: () => api.projectMovePreview(body), onSuccess: () => setStartBlockers(null) });
  const start = useMutation({
    mutationFn: () => api.projectMoveStart({ ...body, repointDns, retainDays, confirmName: projectName }),
    onSuccess: () => {
      setStartBlockers(null);
      qc.invalidateQueries({ queryKey: ["project-moves", projectId] });
    },
    onError: (e) => setStartBlockers(blockersOf(e)),
  });
  const cancel = useMutation({ mutationFn: (id: string) => api.projectMoveCancel(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["project-moves", projectId] }) });
  const purge = useMutation({ mutationFn: (id: string) => api.projectMovePurge(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["project-moves", projectId] }) });

  const options = targetServers(servers.data ?? [], teamId, excludeServerNames);
  const p = preview.data;
  const blockers = startBlockers ?? p?.blockers ?? [];
  const running = moveIsActive(last);
  const err = preview.error ?? (startBlockers ? null : start.error) ?? cancel.error ?? purge.error;

  const onStart = async () => {
    if (!p) return;
    const ok = await confirm({
      title: t("projectMove.start"),
      body: t("projectMove.confirmBody", { n: p.items.length, server: options.find((s) => s.id === target)?.name ?? "", days: retainDays }),
      confirmLabel: t("projectMove.start"),
      confirmText: projectName,
      danger: true,
    });
    if (ok) start.mutate();
  };
  const onPurge = async (id: string) => {
    if (await confirm({ title: t("projectMove.purge"), body: t("projectMove.purgeBody"), confirmLabel: t("projectMove.purge"), danger: true })) purge.mutate(id);
  };

  return (
    <SectionCard title={t("projectMove.title")} desc={t("projectMove.subtitle")}>
      {last && <Progress move={last} />}
      {last && moveCanCancel(last) && (
        <div style={{ marginTop: 10 }}>
          <Btn variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(last.id)} style={{ minHeight: 44 }}>{t("projectMove.cancel")}</Btn>
        </div>
      )}
      {last && moveHasSafetyCopy(last) && (
        <div style={{ marginTop: 10 }}>
          <Btn variant="ghost" disabled={purge.isPending} onClick={() => void onPurge(last.id)} style={{ minHeight: 44 }}>{t("projectMove.purge")}</Btn>
          {purge.data && <span style={{ ...dim, marginLeft: 8 }}>{t("projectMove.purged", { removed: purge.data.removed, kept: purge.data.kept })}</span>}
        </div>
      )}

      {!running && !open && (
        <div style={{ marginTop: last ? 14 : 0 }}>
          <Btn variant="primary" onClick={() => setOpen(true)} style={{ minHeight: 44 }}>{t("projectMove.open")}</Btn>
        </div>
      )}

      {!running && open && (
        <div style={{ marginTop: last ? 14 : 0, display: "grid", gap: 10 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>{t("projectMove.target")}</span>
            <Select value={target} onChange={(v) => { setTarget(v); preview.reset(); setStartBlockers(null); }} ariaLabel={t("projectMove.target")} placeholder={t("projectMove.pickTarget")} options={options.map((s) => ({ value: s.id, label: s.name }))} />
          </label>
          <Btn variant="ghost" disabled={!target || preview.isPending} onClick={() => preview.mutate()} style={{ minHeight: 44 }}>
            {preview.isPending ? t("projectMove.previewing") : t("projectMove.preview")}
          </Btn>

          {p && (
            <div data-testid="project-move-preview">
              <div style={dim}>{t("projectMove.willMove")}</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {p.items.map((i) => (
                  <li key={`${i.kind}:${i.refId}`} style={li}>
                    <Badge tone="muted">{t(`projectMove.item.${i.kind}`)}</Badge>
                    <strong>{i.name}</strong>
                  </li>
                ))}
              </ul>
              {blockers.length > 0 ? (
                <>
                  <div style={{ ...note("var(--c-r)"), fontWeight: 600 }}>{t("projectMove.blockersTitle")}</div>
                  <Blockers blockers={blockers} />
                </>
              ) : (
                <p style={note("var(--c-g)")}>{t("projectMove.noBlockers")}</p>
              )}
              {p.warnings.length > 0 && (
                <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
                  {p.warnings.map((w, i) => <li key={`${w.code}:${w.ref ?? ""}:${i}`} style={dim}>{t(`projectMove.warning.${w.code}`, { ref: w.ref ?? "" })}</li>)}
                </ul>
              )}
              <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                <Checkbox checked={repointDns} onChange={setRepointDns} label={t("projectMove.repointDns")} />
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, flexWrap: "wrap" }}>
                  <span>{t("projectMove.retain.label")}</span>
                  <input type="number" min={0} max={90} value={retainDays} onChange={(e) => setRetainDays(Math.min(90, Math.max(0, Math.trunc(Number(e.target.value) || 0))))} style={{ width: 80, minHeight: 44, boxSizing: "border-box" }} />
                </label>
                <Btn variant="danger" disabled={blockers.length > 0 || start.isPending} onClick={() => void onStart()} style={{ minHeight: 44 }}>
                  {start.isPending ? t("projectMove.starting") : t("projectMove.start")}
                </Btn>
              </div>
            </div>
          )}
        </div>
      )}
      {err && <p role="alert" style={note("var(--c-r)")}>{t(moveErrorKey(err))}</p>}
    </SectionCard>
  );
}
