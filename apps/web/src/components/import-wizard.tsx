"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Card, Btn, EmptyState } from "./ui";
import { useToast } from "./toast";
import { planSummary, itemsByKind, riskTone } from "../lib/import";
import type { ImportPlan, ImportPlanItem, ImportRiskLevel } from "../lib/types";

const toneColor: Record<"danger" | "warning" | "info", string> = {
  danger: "var(--c-r)",
  warning: "var(--c-am)",
  info: "var(--c-tx3)",
};

/** The Coolify import wizard: connect to a Coolify instance, then preview (dry-run) everything it runs as a
 *  secret-free import plan. Apply (create on a target Tugra server) is the next step. Local-docker container
 *  adoption has its own UI on a server's page. */
export function ImportWizard() {
  const t = useT();
  const toast = useToast();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [teamId, setTeamId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);

  const effectiveTeam = teamId || teams[0]?.id || "";

  const planM = useMutation({
    mutationFn: (sessionId: string) => api.importPlan({ sourceKind: "coolify", sessionId }),
    onSuccess: setPlan,
    onError: (e) => toast((e as Error).message, "error"),
  });
  const connect = useMutation({
    mutationFn: () => api.importConnect({ sourceKind: "coolify", teamId: effectiveTeam, baseUrl: baseUrl.trim(), token: token.trim() }),
    onSuccess: (s) => planM.mutate(s.sessionId),
    onError: (e) => toast((e as Error).message || t("import.connectFailed"), "error"),
  });

  const busy = connect.isPending || planM.isPending;

  if (plan) {
    return (
      <PlanView
        plan={plan}
        onReset={() => {
          setPlan(null);
          setToken("");
          connect.reset();
          planM.reset();
        }}
      />
    );
  }

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

function PlanView({ plan, onReset }: { plan: ImportPlan; onReset: () => void }) {
  const t = useT();
  const s = planSummary(plan);
  const groups = itemsByKind(plan);
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
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "14px 0 0" }}>{t("import.applyNote")}</p>
      </Card>

      <Section title={t("import.appsSection")} items={groups.app} />
      <Section title={t("import.databasesSection")} items={groups.database} />
      {groups.volume.length > 0 && <Section title={t("import.volumesSection")} items={groups.volume} />}
    </div>
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
