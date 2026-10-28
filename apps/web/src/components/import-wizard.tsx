"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Card, Btn, EmptyState, Spinner } from "./ui";
import { useToast } from "./toast";
import { useConfirm } from "./confirm";
import { CopyBtn } from "./copy-row";
import { planSummary, itemsByKind, riskTone, opProgress } from "../lib/import";
import type { ImportPlan, ImportPlanItem, ImportRiskLevel, ImportOperation, ImportTaskStatus, MintedMigrationToken, ImportRemapPlan, ImportRemapResult } from "../lib/types";

const toneColor: Record<"danger" | "warning" | "info", string> = {
  danger: "var(--c-r)",
  warning: "var(--c-am)",
  info: "var(--c-tx3)",
};

function statusColor(s: ImportTaskStatus): string {
  if (s === "DONE") return "var(--c-g)";
  if (s === "FAILED" || s === "FAILED_VERIFY") return "var(--c-r)";
  if (s === "SKIPPED" || s === "ROLLED_BACK" || s === "CANCELLED") return "var(--c-tx3)";
  return "var(--c-am)"; // PENDING | RUNNING | AWAITING_CUTOVER
}

/** The Coolify import wizard: connect → preview (secret-free plan) → apply onto a target Tugra server →
 *  watch the live timeline. Local-docker container adoption keeps its own UI on a server's page. */
export function ImportWizard() {
  const t = useT();
  const toast = useToast();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });

  const [teamId, setTeamId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [opId, setOpId] = useState<string | null>(null);

  const effectiveTeam = teamId || teams[0]?.id || "";

  const planM = useMutation({
    mutationFn: (sid: string) => api.importPlan({ sourceKind: "coolify", sessionId: sid }),
    onSuccess: setPlan,
    onError: (e) => toast((e as Error).message, "error"),
  });
  const connect = useMutation({
    mutationFn: () => api.importConnect({ sourceKind: "coolify", teamId: effectiveTeam, baseUrl: baseUrl.trim(), token: token.trim() }),
    onSuccess: (s) => {
      setSessionId(s.sessionId);
      planM.mutate(s.sessionId);
    },
    onError: (e) => toast((e as Error).message || t("import.connectFailed"), "error"),
  });

  const reset = () => {
    setPlan(null);
    setSessionId(null);
    setOpId(null);
    setToken("");
    connect.reset();
    planM.reset();
  };

  if (opId) return <Timeline opId={opId} onReset={reset} />;

  if (plan && sessionId) {
    return (
      <PlanView
        plan={plan}
        servers={servers.filter((s) => s.teamId === effectiveTeam).map((s) => ({ id: s.id, name: s.name }))}
        sessionId={sessionId}
        onApplied={setOpId}
        onReset={reset}
      />
    );
  }

  const busy = connect.isPending || planM.isPending;
  return (
    <Card style={{ padding: 20, maxWidth: 560 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("import.sourceCoolify")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 16px" }}>{t("import.sourceCoolifyHint")}</p>

      <label style={label} htmlFor="imp-team">{t("import.team")}</label>
      <select id="imp-team" style={field} value={effectiveTeam} onChange={(e) => setTeamId(e.target.value)}>
        {teams.map((tm) => (
          <option key={tm.id} value={tm.id}>{tm.name}</option>
        ))}
      </select>

      <label style={label} htmlFor="imp-url">{t("import.baseUrl")}</label>
      <input id="imp-url" style={field} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t("import.baseUrlPlaceholder")} inputMode="url" autoComplete="off" spellCheck={false} />

      <label style={label} htmlFor="imp-token">{t("import.token")}</label>
      <input id="imp-token" style={field} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "-6px 0 16px" }}>{t("import.tokenHint")}</p>

      {connect.isError && <div style={{ color: "var(--c-r)", fontSize: 12, marginBottom: 10 }}>{(connect.error as Error).message}</div>}

      <Btn onClick={() => connect.mutate()} disabled={busy || !effectiveTeam || !baseUrl.trim() || !token.trim()}>
        {connect.isPending ? t("import.connecting") : planM.isPending ? t("import.planning") : t("import.connect")}
      </Btn>

      <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "16px 0 0" }}>{t("import.localDockerHint")}</p>
    </Card>
  );
}

function PlanView({
  plan,
  servers,
  sessionId,
  onApplied,
  onReset,
}: {
  plan: ImportPlan;
  servers: { id: string; name: string }[];
  sessionId: string;
  onApplied: (opId: string) => void;
  onReset: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const s = planSummary(plan);
  const groups = itemsByKind(plan);
  const [targetServerId, setTargetServerId] = useState("");
  const target = targetServerId || servers[0]?.id || "";

  const apply = useMutation({
    mutationFn: () => api.importApply({ sourceKind: "coolify", sessionId, targetServerId: target, planHash: plan.planHash }),
    onSuccess: (r) => onApplied(r.opId),
    onError: (e) => toast((e as Error).message, "error"),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <Card style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600, flex: 1 }}>{t("import.planTitle")}</div>
          <Btn variant="ghost" onClick={onReset}>{t("import.startOver")}</Btn>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Stat label={t("import.apps")} value={s.apps} />
          <Stat label={t("import.databases")} value={s.databases} />
          <Stat label={t("import.volumes")} value={s.volumes} />
          <Stat label={t("import.blockers")} value={s.blockers} danger={s.blockers > 0} />
        </div>
        {plan.warnings.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("import.warnings")}</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--c-am)" }}>
              {plan.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ borderTop: "1px solid var(--c-bd)", margin: "16px 0 14px" }} />
        <label style={label} htmlFor="imp-target">{t("import.target")}</label>
        {servers.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--c-am)", margin: "0 0 8px" }}>{t("import.noTarget")}</p>
        ) : (
          <select id="imp-target" style={{ ...field, maxWidth: 320 }} value={target} onChange={(e) => setTargetServerId(e.target.value)}>
            {servers.map((sv) => (
              <option key={sv.id} value={sv.id}>{sv.name}</option>
            ))}
          </select>
        )}
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "-4px 0 12px" }}>{t("import.targetHint")}</p>
        <Btn onClick={() => apply.mutate()} disabled={apply.isPending || !target || !s.runnable}>
          {apply.isPending ? t("import.applying") : t("import.apply")}
        </Btn>
      </Card>

      <Section title={t("import.appsSection")} items={groups.app} />
      <Section title={t("import.databasesSection")} items={groups.database} />
      {groups.volume.length > 0 && <Section title={t("import.volumesSection")} items={groups.volume} />}
    </div>
  );
}

function Timeline({ opId, onReset }: { opId: string; onReset: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: op } = useQuery({
    queryKey: ["import-op", opId],
    queryFn: () => api.getImportOperation(opId),
    refetchInterval: (q) => {
      const d = q.state.data as ImportOperation | undefined;
      return d && opProgress(d).settled ? false : 2000;
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelImport(opId),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const rollback = useMutation({
    mutationFn: () => api.rollbackImport(opId),
    onSuccess: (updated) => qc.setQueryData(["import-op", opId], updated),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const onRollback = async () => {
    const ok = await confirm({ title: t("import.rollbackTitle"), body: t("import.rollbackBody"), danger: true });
    if (ok) rollback.mutate();
  };

  if (!op) {
    return (
      <Card style={{ padding: 20, maxWidth: 720, display: "flex", alignItems: "center", gap: 10 }}>
        <Spinner /> {t("import.timelineTitle")}
      </Card>
    );
  }

  const prog = opProgress(op);
  const canRollback = prog.settled && op.tasks.some((task) => task.status === "DONE" && task.resourceType === "application");
  // Post-import steps only make sense once apps have actually landed (same condition as rollback).
  const showPostSteps = canRollback;
  return (
    <>
    <Card style={{ padding: 20, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600, flex: 1 }}>{t("import.timelineTitle")} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>· {op.status}</span></div>
        {!prog.settled && (
          <Btn variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending || op.cancelRequested}>
            {cancel.isPending || op.cancelRequested ? t("import.cancelling") : t("import.cancel")}
          </Btn>
        )}
        {canRollback && (
          <Btn variant="ghost" onClick={onRollback} disabled={rollback.isPending}>
            {rollback.isPending ? t("import.rollingBack") : t("import.rollback")}
          </Btn>
        )}
        {prog.settled && <Btn variant="ghost" onClick={onReset}>{t("import.startOver")}</Btn>}
      </div>

      <div role="progressbar" aria-valuenow={prog.pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, background: "var(--c-sur)", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
        <div style={{ width: `${prog.pct}%`, height: "100%", background: prog.failed > 0 ? "var(--c-am)" : "var(--c-g)", transition: "width .4s" }} />
      </div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 14 }}>
        {prog.done}/{prog.total} · {prog.pct}%{prog.failed > 0 ? ` · ${t("import.failedCount", { n: prog.failed })}` : ""}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {op.tasks.map((task, i) => (
          <div key={task.itemRef ?? i} style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8, fontSize: 12, borderBottom: "1px solid var(--c-bd)", paddingBottom: 6 }}>
            <span style={{ color: statusColor(task.status), fontWeight: 600, minWidth: 90 }}>{task.status}</span>
            <span className="mono" style={{ flex: 1, wordBreak: "break-all" }}>{task.name ?? task.itemRef}</span>
            {typeof task.unresolvedEnv === "number" && task.unresolvedEnv > 0 && (
              <span style={{ color: "var(--c-am)" }}>{t("import.unresolvedEnv", { n: task.unresolvedEnv })}</span>
            )}
            {task.message && <span style={{ color: "var(--c-tx3)", flexBasis: "100%", paddingLeft: 98 }}>{task.message}</span>}
          </div>
        ))}
      </div>
    </Card>
    {showPostSteps && (
      <>
        <MigrateDataCard opId={opId} />
        <RemapEnvCard opId={opId} />
      </>
    )}
    </>
  );
}

/** A copyable one-line command (mono, with a Copy button); `muted` greys it as a template, not a live command. */
function CommandBox({ cmd, muted }: { cmd: string; muted?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "var(--c-sur)", border: "1px solid var(--c-bd)", borderRadius: 8, padding: 10 }}>
      <code className="mono" style={{ flex: 1, fontSize: 11, wordBreak: "break-all", whiteSpace: "pre-wrap", color: muted ? "var(--c-tx3)" : "var(--c-tx)" }}>{cmd}</code>
      <CopyBtn text={cmd} />
    </div>
  );
}

/** Post-import step 1 — database DATA migration: mint the one-time token and show the one-liner the operator
 *  pastes on the SOURCE host to pull each database's data over. The live command is shown once; after that the
 *  read-only state shows active/expiry + a Reissue. */
function MigrateDataCard({ opId }: { opId: string }) {
  const t = useT();
  const toast = useToast();
  const [minted, setMinted] = useState<MintedMigrationToken | null>(null);
  const { data: state } = useQuery({ queryKey: ["migrate-command", opId], queryFn: () => api.getMigrateCommand(opId) });
  const mint = useMutation({
    mutationFn: (reissue: boolean) => (reissue ? api.reissueMigrationToken(opId) : api.mintMigrationToken(opId)),
    onSuccess: (r) => setMinted(r),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const active = !!state?.active;
  return (
    <Card style={{ padding: 20, maxWidth: 720, marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("import.migrateTitle")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("import.migrateDesc")}</p>
      {minted ? (
        <>
          <div style={{ fontSize: 12, color: "var(--c-am)", marginBottom: 6 }}>{t("import.migrateTokenOnce")}</div>
          <CommandBox cmd={minted.command} />
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6 }}>{t("import.migrateExpires", { date: new Date(minted.expiresAt).toLocaleString() })}</div>
        </>
      ) : (
        <>
          {active && <div style={{ fontSize: 12, color: "var(--c-g)", marginBottom: 8 }}>{t("import.migrateActive", { date: state?.expiresAt ? new Date(state.expiresAt).toLocaleString() : "" })}</div>}
          {state?.commandTemplate && <CommandBox cmd={state.commandTemplate} muted />}
          <div style={{ marginTop: 10 }}>
            <Btn onClick={() => mint.mutate(active)} disabled={mint.isPending}>
              {mint.isPending ? "…" : active ? t("import.migrateReissue") : t("import.migrateGenerate")}
            </Btn>
          </div>
        </>
      )}
    </Card>
  );
}

/** Post-import step 2 — env remap: preview the (secret-masked) rewrites that point each migrated app at its new
 *  Tugra database, then apply (confirm-gated by the planHash) or undo. Pure wiring over the importer API. */
function RemapEnvCard({ opId }: { opId: string }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [plan, setPlan] = useState<ImportRemapPlan | null>(null);
  const [result, setResult] = useState<ImportRemapResult | null>(null);
  const preview = useMutation({
    mutationFn: () => api.remapEnvPlan(opId),
    onSuccess: (p) => { setPlan(p); setResult(null); },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const apply = useMutation({
    mutationFn: (hash: string) => api.remapEnvApply(opId, hash),
    onSuccess: (r) => { setResult(r); setPlan(null); toast(t("import.remapApplied"), "success"); },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const undo = useMutation({
    mutationFn: () => api.remapEnvUndo(opId),
    onSuccess: (r) => { setResult(r); toast(t("import.remapUndone"), "success"); },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const onApply = async () => {
    if (!plan) return;
    const ok = await confirm({ title: t("import.remapApplyTitle"), body: t("import.remapApplyBody") });
    if (ok) apply.mutate(plan.planHash);
  };
  const changeCount = plan?.apps.reduce((n, a) => n + a.changes.length, 0) ?? 0;
  const manualCount = plan?.apps.reduce((n, a) => n + a.needsManual.length, 0) ?? 0;
  return (
    <Card style={{ padding: 20, maxWidth: 720, marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("import.remapTitle")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("import.remapDesc")}</p>

      {!plan && !result && (
        <Btn onClick={() => preview.mutate()} disabled={preview.isPending}>{preview.isPending ? "…" : t("import.remapPreview")}</Btn>
      )}

      {plan && !result && (
        <>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>
            {t("import.remapSummary", { apps: plan.apps.length, changes: changeCount })}
            {manualCount > 0 ? ` · ${t("import.remapManual", { n: manualCount })}` : ""}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
            {plan.apps.map((a) => (
              <div key={a.appId} style={{ border: "1px solid var(--c-bd)", borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{a.name}</div>
                {a.changes.map((c) => (
                  <div key={c.key} style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 4, wordBreak: "break-all" }}>
                    <span className="mono">{c.key}</span>: <span style={{ color: "var(--c-tx2)" }}>{c.oldMasked}</span> → <span style={{ color: "var(--c-g)" }}>{c.newMasked}</span>
                  </div>
                ))}
                {a.needsManual.map((m) => (
                  <div key={m.key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--c-am)", marginTop: 4 }}><TriangleAlert size={12} aria-hidden style={{ flexShrink: 0 }} /> <span className="mono">{m.key}</span> — {m.reason}</div>
                ))}
                {a.dbNetwork && (
                  <div style={{ fontSize: 11, color: a.dbNetwork.willLink ? "var(--c-g)" : "var(--c-am)", marginTop: 4 }}>
                    {a.dbNetwork.willLink ? t("import.remapWillLink") : t("import.remapNoLink", { reason: a.dbNetwork.reason ?? "" })}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={onApply} disabled={apply.isPending || changeCount === 0}>{apply.isPending ? t("import.applying") : t("import.remapApply")}</Btn>
            <Btn variant="ghost" onClick={() => setPlan(null)} disabled={apply.isPending}>{t("import.remapDiscard")}</Btn>
          </div>
        </>
      )}

      {result && (
        <>
          <div style={{ fontSize: 12, color: "var(--c-tx2)", marginBottom: 10, lineHeight: 1.5 }}>{result.note}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>
            {t("import.remapResult", { n: result.apps.length })}{result.failed.length > 0 ? ` · ${t("import.remapResultFailed", { n: result.failed.length })}` : ""}
          </div>
          {result.applied && (
            <Btn variant="ghost" onClick={() => undo.mutate()} disabled={undo.isPending}>{undo.isPending ? "…" : t("import.remapUndo")}</Btn>
          )}
        </>
      )}
    </Card>
  );
}

function Section({ title, items }: { title: string; items: ImportPlanItem[] }) {
  const t = useT();
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
        {title} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>({items.length})</span>
      </div>
      {items.length === 0 ? (
        <EmptyState>{t("import.none")}</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((it) => (
            <ItemRow key={it.itemRef} item={it} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ItemRow({ item }: { item: ImportPlanItem }) {
  return (
    <div style={{ borderBottom: "1px solid var(--c-bd)", paddingBottom: 8 }}>
      <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>{item.name}</span>
      {item.risks.length > 0 && (
        <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11 }}>
          {item.risks.map((r, i) => (
            <li key={i} style={{ color: toneColor[riskTone(r.level as ImportRiskLevel)] }}>{r.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label: lbl, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 14px", minWidth: 80 }}>
      <div style={{ fontSize: 20, fontWeight: 600, color: danger ? "var(--c-r)" : "var(--c-tx)" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{lbl}</div>
    </div>
  );
}

const label: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--c-tx3)", margin: "0 0 4px" };
const field: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  fontSize: 13,
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  marginBottom: 12,
  fontFamily: "inherit",
};
