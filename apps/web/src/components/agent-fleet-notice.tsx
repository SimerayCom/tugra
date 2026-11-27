"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { useToast } from "./toast";
import { Btn } from "./ui";
import { useOptionalConfirm } from "./confirm";
import { InFlightList } from "./in-flight-list";
import { inFlightLines } from "../lib/in-flight";
import type { AgentUpdateResponse, InFlightItem } from "../lib/types";

/**
 * "3/24 agents are on an older version" with a one-click "Update all". Counts only the remote agents of teams the
 * caller manages (the hub decides; a viewer never sees it). With "Apply updates automatically" on, the hub already
 * rolls them out one by one, and the line says so; the button stays for anyone who does not want to wait.
 */
/** Settings → Instance → Updates, where "Apply updates automatically" lives (owner-only; others see it read-only). */
export const AUTO_UPDATE_SETTINGS = "/settings?tab=instance&section=backups#updates";

/** One line under an "agents are behind" summary: a link to turn on automatic updates, shown only while it is off. */
export function AutoUpdateHint() {
  const t = useT();
  const { data } = useQuery({ queryKey: ["agentFleetStatus"], queryFn: () => api.getAgentFleetStatus(), retry: false });
  if (!data || data.outdated === 0 || data.autoUpdate) return null;
  return (
    <Link href={AUTO_UPDATE_SETTINGS} style={{ display: "inline-block", fontSize: 12, color: "var(--c-lapis)", textDecoration: "none", marginBottom: 10 }}>
      {t("servers.agentFleetTurnOnAuto")} →
    </Link>
  );
}

export function AgentFleetNotice() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["agentFleetStatus"],
    queryFn: () => api.getAgentFleetStatus(),
    refetchInterval: 15_000,
    retry: false,
  });
  const confirm = useOptionalConfirm();
  const updateAll = useMutation({
    // Servers with work in flight are left out and reported; "Update anyway" then sends just those, with force (owner/admin of their team).
    mutationFn: async (): Promise<AgentUpdateResponse> => {
      const first = await api.updateOutdatedAgents();
      const heldIds = first.results.filter((r) => r.status === "held" && r.reason !== "force-not-permitted").map((r) => r.serverId);
      if (heldIds.length === 0 || !confirm) return first;
      const items = new Map<string, InFlightItem>();
      for (const r of first.results) for (const i of r.inFlight ?? []) items.set(`${i.kind}:${i.id}`, i);
      const go = await confirm({
        title: t("inFlight.updateAnywayTitle"),
        body: `${t("servers.agentFleetHeldBody", { n: heldIds.length })}\n\n${inFlightLines(t, [...items.values()])}\n\n${t("inFlight.updateAnywayAgentBody")}`,
        confirmLabel: t("inFlight.updateAnyway"),
        cancelLabel: t("inFlight.wait"),
        danger: true,
      });
      if (!go) return first;
      const forced = await api.bulkUpdateAgent(heldIds, true);
      return { ...forced, total: first.total, sent: first.sent + forced.sent, offline: first.offline + forced.offline, skipped: first.skipped + forced.skipped };
    },
    onSuccess: (res) => {
      if (res.status === "hub-behind") toast(t("servers.agentFleetHubBehind"), "info");
      else if (res.status === "ok" && res.sent > 0) toast(t("servers.agentFleetSent", { n: res.sent }), "success");
      else if (res.status === "ok" && res.held > 0) toast(t("servers.agentFleetHeldToast", { n: res.held }), "info");
      else toast(t("servers.agentFleetNone"), "info");
      void qc.invalidateQueries({ queryKey: ["agentFleetStatus"] });
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("servers.agentFleetFailed"), "error"),
  });
  if (!data || data.outdated === 0) return null;
  // Held servers that are also behind: what is running on them, each piece of work once.
  const heldItems = new Map<string, InFlightItem>();
  const behindIds = new Set(data.outdatedServerIds);
  for (const h of data.held ?? []) if (behindIds.has(h.serverId)) for (const i of h.inFlight) heldItems.set(`${i.kind}:${i.id}`, i);
  const heldCount = (data.held ?? []).filter((h) => behindIds.has(h.serverId)).length;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "space-between",
        padding: "10px 14px", marginBottom: 16, border: "1px solid var(--c-bd)", borderLeft: "3px solid var(--c-am)",
        borderRadius: "var(--r2, 8px)", background: "var(--c-el)",
      }}
    >
      <div style={{ minWidth: 200 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{t("servers.agentFleetBehind", { n: data.outdated, total: data.total })}</div>
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t(!data.autoUpdate ? "servers.agentFleetManual" : data.hubBehind ? "servers.agentFleetWaitingHub" : "servers.agentFleetAuto")}</div>
        {heldCount > 0 && (
          <div data-testid="agent-fleet-held" style={{ fontSize: 12, color: "var(--c-am)", marginTop: 4 }}>
            {t("servers.agentFleetHeld", { n: heldCount })}
            <InFlightList items={[...heldItems.values()]} max={4} testId="agent-fleet-held-list" />
          </div>
        )}
        {!data.autoUpdate && (
          <Link href={AUTO_UPDATE_SETTINGS} style={{ fontSize: 12, color: "var(--c-lapis)", textDecoration: "none" }}>{t("servers.agentFleetTurnOnAuto")} →</Link>
        )}
      </div>
      <Btn variant="ghost" style={{ minHeight: 44 }} onClick={() => updateAll.mutate()} loading={updateAll.isPending} disabled={updateAll.isPending}>
        {t("servers.agentFleetUpdateAll")}
      </Btn>
    </div>
  );
}
