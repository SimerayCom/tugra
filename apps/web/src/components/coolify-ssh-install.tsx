"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n/provider";
import { formatDateTime } from "../lib/format-time";
import { confirmText, pollInterval, runCounts, runPhase, sshCandidates, stateTone, type CoolifySshRunView } from "../lib/coolify-ssh";
import type { CoolifyChecklist } from "../lib/coolify-takeover";
import { Badge, Btn, SectionCard } from "./ui";
import { Checkbox, Select } from "./form";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";

type T = ReturnType<typeof useT>;

/** A localized line for a failed call: the hub's stable code when we know it, else a generic one. */
function errorText(t: T, e: unknown): string {
  if (e instanceof ApiError) {
    const key = `coolifyInstall.error.${e.code ?? ""}`;
    const text = t(key);
    if (e.code && text !== key) return text;
    if (e.status === 403) return t("coolifyInstall.error.forbidden");
  }
  return t("coolifyInstall.error.generic");
}

function Row({ run, t }: { run: CoolifySshRunView; t: T }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={t("coolifyInstall.run.heading")}>
      {run.targets.map((x) => (
        <li key={x.id} style={{ borderTop: "1px solid var(--c-bd)", padding: "8px 0", display: "grid", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 44 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--c-tx)", flex: "1 1 140px", overflowWrap: "anywhere" }}>{x.name}</span>
            <Badge tone={stateTone(x.state)}>{t(`coolifyInstall.state.${x.state}`)}</Badge>
          </div>
          {x.code && x.state !== "ONLINE" && (
            <p role="status" style={{ margin: 0, fontSize: 12, color: x.state === "FAILED" ? "var(--c-r)" : "var(--c-tx3)", lineHeight: 1.5 }}>
              {t(`coolifyInstall.code.${x.code}`)}
            </p>
          )}
          {x.manualCommand && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifyInstall.run.manualHint")}</p>}
          {x.probe?.hostKeyPinned && <p style={{ margin: 0, fontSize: 11, color: "var(--c-tx3)" }}>{t("coolifyInstall.run.hostKeyPinned")}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Install the Tugra agent on Coolify's other servers": one card on the Coolify page. It checks the servers first (read-only), then installs
 * on the ones that are ready, with Coolify's own SSH keys, which never leave the Coolify server. Team owners only (the hub enforces it; a
 * non-owner sees why instead of buttons). Nothing here shows a token, a key or a command line.
 */
export function CoolifySshInstall({ serverId, rows, teams, ownerOfInventory }: { serverId: string; rows: CoolifyChecklist["rows"]; teams: CoolifyChecklist["teams"]; ownerOfInventory: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const key = ["coolify-ssh-run", serverId];
  const candidates = useMemo(() => sshCandidates(rows), [rows]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [teamId, setTeamId] = useState("");
  // Opened from the import wizard (?session=<import session>): each server then goes into the Tugra team its Coolify team was mapped to.
  const [importSessionId, setImportSessionId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get("session");
    if (sid) setImportSessionId(sid);
  }, []);

  const { data: run } = useQuery({
    queryKey: key,
    queryFn: () => api.coolifySshLatest(serverId),
    gcTime: 0,
    refetchInterval: (q) => pollInterval(q.state.data as CoolifySshRunView | null | undefined),
  });

  const picked = candidates.filter((r) => !off.has(r.coolifyServerUuid));
  const team = teamId || candidates.find((r) => r.teamId)?.teamId || teams[0]?.id || "";
  const phase = runPhase(run);
  const counts = runCounts(run);
  const busy = counts.working > 0;

  const onError = (e: unknown) => toast(errorText(t, e), "error");
  const set = (r: CoolifySshRunView) => qc.setQueryData(key, r);
  const start = useMutation({ mutationFn: (uuids: string[]) => api.coolifySshStart(serverId, { coolifyServerUuids: uuids, teamId: team, confirm: confirmText(uuids.length), ...(importSessionId ? { importSessionId } : {}) }), onSuccess: set, onError });
  const install = useMutation({ mutationFn: (r: CoolifySshRunView) => api.coolifySshInstall(serverId, r.runId, { confirm: confirmText(counts.ready) }), onSuccess: set, onError });
  const uninstall = useMutation({ mutationFn: (r: CoolifySshRunView) => api.coolifySshUninstall(serverId, r.runId, { confirm: confirmText(counts.removable) }), onSuccess: set, onError });
  const cancel = useMutation({ mutationFn: (r: CoolifySshRunView) => api.coolifySshCancel(serverId, r.runId), onSuccess: set, onError });

  const onCheck = async () => {
    const n = picked.length;
    const ok = await confirm({ title: t("coolifyInstall.card.title", { count: n }), body: t("coolifyInstall.probe.title"), confirmLabel: t("coolifyInstall.card.check", { count: n }), confirmText: confirmText(n) });
    if (ok) start.mutate(picked.map((r) => r.coolifyServerUuid));
  };
  const onInstall = async () => {
    if (!run) return;
    const ok = await confirm({ title: t("coolifyInstall.run.installTitle"), body: t("coolifyInstall.run.installBody", { count: counts.ready }), confirmLabel: t("coolifyInstall.card.install"), confirmText: confirmText(counts.ready) });
    if (ok) install.mutate(run);
  };
  const onRemove = async () => {
    if (!run) return;
    const ok = await confirm({ title: t("coolifyInstall.run.removeTitle"), body: t("coolifyInstall.run.removeBody", { count: counts.removable }), confirmLabel: t("coolifyInstall.card.rollback"), confirmText: confirmText(counts.removable), danger: true });
    if (ok) uninstall.mutate(run);
  };

  if (candidates.length === 0 && !run) return null;
  const showStart = !run || phase === "done";

  return (
    <SectionCard title={t("coolifyInstall.title")} desc={t("coolifyInstall.subtitle")}>
      <details style={{ marginBottom: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, minHeight: 44, display: "flex", alignItems: "center" }}>{t("coolifyInstall.card.details")}</summary>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13, color: "var(--c-tx2)", display: "grid", gap: 4, lineHeight: 1.5 }}>
          {(["keys", "probe", "install", "existing", "undo", "consent", "audit"] as const).map((k) => (
            <li key={k}>{t(`coolifyInstall.what.${k}`)}</li>
          ))}
        </ul>
      </details>

      {!ownerOfInventory && <p role="note" style={{ margin: "0 0 12px", fontSize: 13, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifyInstall.card.ownerOnly")}</p>}

      {run && (
        <div style={{ marginBottom: 12 }}>
          {busy && <p role="status" style={{ margin: "0 0 6px", fontSize: 13, color: "var(--c-tx2)" }}>{phase === "probing" ? t("coolifyInstall.card.checking", { count: counts.total }) : t("coolifyInstall.run.working")}</p>}
          {!busy && phase === "ready" && <p role="status" style={{ margin: "0 0 6px", fontSize: 13, color: "var(--c-tx2)" }}>{t("coolifyInstall.probe.done", { ready: counts.ready, skipped: counts.skipped, failed: counts.failed })}</p>}
          {!busy && phase === "done" && counts.online > 0 && <p role="status" style={{ margin: "0 0 6px", fontSize: 13, color: "var(--c-g)" }}>{t("coolifyInstall.run.finished", { online: counts.online })}</p>}
          <Row run={run} t={t} />
          {phase === "ready" && !run.finished && <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--c-tx3)" }}>{t("coolifyInstall.run.expires", { when: formatDateTime(run.expiresAt) })}</p>}
        </div>
      )}

      {showStart && candidates.length > 0 && (
        <div style={{ marginBottom: 12, display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyInstall.card.pick")}</span>
          {candidates.map((r) => (
            <Checkbox
              key={r.coolifyServerUuid}
              checked={!off.has(r.coolifyServerUuid)}
              onChange={(on) => setOff((s) => { const n = new Set(s); if (on) n.delete(r.coolifyServerUuid); else n.add(r.coolifyServerUuid); return n; })}
              label={
                <span style={{ fontWeight: 600, color: "var(--c-tx)" }}>
                  {r.name} <span className="mono" style={{ fontWeight: 400, fontSize: 12, color: "var(--c-tx3)" }}>({r.ip})</span>
                </span>
              }
            />
          ))}
          {importSessionId && <p role="note" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("coolifyInstall.card.followsMapping")}</p>}
          {teams.length > 1 && !importSessionId && (
            <Select value={team} onChange={setTeamId} options={teams.map((x) => ({ value: x.id, label: x.name }))} ariaLabel={t("coolifyInstall.card.team")} style={{ maxWidth: 260 }} />
          )}
        </div>
      )}
      {showStart && candidates.length === 0 && <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--c-tx3)" }}>{t("coolifyInstall.card.none")}</p>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {showStart && candidates.length > 0 && (
          <Btn disabled={!ownerOfInventory || picked.length === 0 || !team} loading={start.isPending} onClick={onCheck}>
            {picked.length === 1 ? t("coolifyInstall.card.titleOne") : t("coolifyInstall.card.title", { count: picked.length })}
          </Btn>
        )}
        {run && phase === "ready" && (
          <Btn disabled={!ownerOfInventory} loading={install.isPending} onClick={onInstall}>{t("coolifyInstall.run.installReady", { count: counts.ready })}</Btn>
        )}
        {run && counts.removable > 0 && !busy && (
          <Btn variant="dangerGhost" disabled={!ownerOfInventory} loading={uninstall.isPending} onClick={onRemove}>{t("coolifyInstall.run.removeAll", { count: counts.removable })}</Btn>
        )}
        {run && (phase === "probing" || phase === "ready" || phase === "installing") && (
          <Btn variant="ghost" disabled={!ownerOfInventory} loading={cancel.isPending} onClick={() => cancel.mutate(run)}>{t("coolifyInstall.run.cancel")}</Btn>
        )}
      </div>
    </SectionCard>
  );
}
