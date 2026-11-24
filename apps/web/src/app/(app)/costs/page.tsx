"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, Wallet } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { ErrorState } from "../../../components/error-state";
import { TeamPicker } from "../../../components/team-picker";
import { useToast } from "../../../components/toast";
import { ServerCostList } from "../../../components/costs/server-cost-list";
import { BeforeAfterCard } from "../../../components/costs/before-after-card";
import { SizeAdviceList } from "../../../components/costs/size-advice-list";
import { formatMoney, type TeamCost } from "../../../lib/costs";

export default function CostsPage() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [pickedTeam, setPickedTeam] = useState("");
  const teamId = pickedTeam || teams[0]?.id || "";

  const costs = useQuery({ queryKey: ["costs", teamId], queryFn: () => api.getCosts(teamId), enabled: !!teamId });
  const advice = useQuery({ queryKey: ["costs-advice", teamId], queryFn: () => api.getCostAdvice(teamId), enabled: !!teamId });
  const team = costs.data?.teams.find((x) => x.teamId === teamId);

  const sync = useMutation({
    mutationFn: () => api.syncCosts(teamId),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["costs"] });
      qc.invalidateQueries({ queryKey: ["costs-advice"] });
      toast(r.synced > 0 ? t("costs.refresh.done", { n: r.synced }) : t("costs.refresh.nothing"), "success");
    },
  });

  // A server linked to a provider API gets its real price on its own, once per visit and team; failures stay quiet
  // (the estimate stands, and the button reports them).
  const autoSynced = useRef(new Set<string>());
  // A provider price older than a day is read again too, so a resize made at the provider shows up.
  const stale = (s: { source: string; syncedAt: string | null }) => s.source === "estimate" || (s.source === "provider" && (!s.syncedAt || Date.now() - Date.parse(s.syncedAt) > 86_400_000));
  const wantsAuto = !!team && team.canOps && team.servers.some((s) => s.canSync && stale(s));
  useEffect(() => {
    if (!wantsAuto || autoSynced.current.has(teamId)) return;
    autoSynced.current.add(teamId);
    api
      .syncCosts(teamId)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["costs"] });
        qc.invalidateQueries({ queryKey: ["costs-advice"] });
      })
      .catch(() => undefined);
  }, [wantsAuto, teamId, qc]);

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <Wallet size={20} color="var(--c-a)" aria-hidden /> {t("costs.title")}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: "0 0 18px" }}>{t("costs.subtitle")}</p>

      {teams.length > 1 && (
        <div style={{ maxWidth: 280, marginBottom: 16 }}>
          <TeamPicker value={teamId} onChange={setPickedTeam} teams={teams} ariaLabel={t("costs.team")} />
        </div>
      )}

      {costs.isError && !team ? (
        <ErrorState onRetry={() => costs.refetch()} />
      ) : costs.isLoading || !team ? (
        <Spinner />
      ) : team.servers.length === 0 ? (
        <Card style={{ padding: 16 }}>
          <EmptyState icon={Wallet} title={t("costs.empty.title")}>
            {t("costs.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Summary team={team} onSync={() => sync.mutate()} syncing={sync.isPending} />
          {sync.isError && (
            <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, margin: "-8px 0 12px" }}>
              {(sync.error as Error).message}
            </div>
          )}
          {sync.data?.failed.map((f) => (
            <div key={f.credentialName} role="alert" style={{ color: "var(--c-r)", fontSize: 12, margin: "-8px 0 12px" }}>
              {t("costs.refresh.failed", { name: f.credentialName, message: f.message })}
            </div>
          ))}
          {advice.data && <SizeAdviceList advice={advice.data.advice.filter((a) => a.teamId === teamId)} snapshotDate={advice.data.snapshotDate} canManage={team.canManage} />}
          <BeforeAfterCard team={team} />
          <ServerCostList team={team} />
        </>
      )}
    </div>
  );
}

function Summary({ team, onSync, syncing }: { team: TeamCost; onSync: () => void; syncing: boolean }) {
  const t = useT();
  const canSync = team.canOps && team.servers.some((s) => s.canSync);
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("costs.total.title")}</div>
          {team.totals.length === 0 ? (
            <div style={{ fontSize: 16, color: "var(--c-tx3)", marginTop: 4 }}>{t("costs.total.none")}</div>
          ) : (
            team.totals.map((x) => (
              <div key={x.currency} style={{ marginTop: 4 }}>
                <span style={{ fontSize: 30, fontWeight: 700 }}>{t("costs.perMonth", { amount: formatMoney(x.monthlyCents, x.currency) })}</span>
                <span style={{ fontSize: 12, color: "var(--c-tx3)", marginLeft: 8 }}>{t("costs.total.servers", { n: x.servers })}</span>
                {x.estimatedCents > 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("costs.total.estimates", { amount: formatMoney(x.estimatedCents, x.currency) })}</div>}
              </div>
            ))
          )}
          <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6 }}>
            {t("costs.total.vat")}
          </div>
        </div>
        {canSync && (
          <Btn variant="ghost" icon={RefreshCw} onClick={onSync} loading={syncing}>
            {syncing ? t("costs.refresh.busy") : t("costs.refresh.action")}
          </Btn>
        )}
      </div>
    </Card>
  );
}
