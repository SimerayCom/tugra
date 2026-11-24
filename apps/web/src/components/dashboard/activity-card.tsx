"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ScrollText } from "lucide-react";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/fleet";
import { humanizeEvent, summarizeActivity } from "../../lib/dashboard-activity";
import { useAuth } from "../../lib/auth";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { CardLink, CardNote, DashCard } from "./dash-card";

const ACTIVITY_LIMIT = 8;
const KEY = "tugra.dashboardShowSystemEvents";

function useShowSystemEvents(): [boolean, (v: boolean) => void] {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      setShow(localStorage.getItem(KEY) === "1");
    } catch { /* storage unavailable */ }
  }, []);
  const set = useCallback((v: boolean) => {
    setShow(v);
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch { /* the choice just isn't remembered */ }
  }, []);
  return [show, set];
}

/** Recent activity as readable sentences. Housekeeping and read-only events (MCP calls, GPU refreshes, profile
 *  edits) fold into one counted line each until "Show system events" is on; the audit log itself is untouched. */
export function ActivityCard({ teamId }: { teamId: string | null }) {
  const t = useT();
  const { user } = useAuth();
  const [showSystem, setShowSystem] = useShowSystemEvents();
  // Own key (not ["audit"]) so this plain {entries} result never collides with the Audit page's useInfiniteQuery.
  const { data: audit } = useQuery({ queryKey: ["audit-recent", teamId], queryFn: () => api.listAudit(teamId ?? undefined) });
  const { lines, quietCount } = summarizeActivity(audit?.entries ?? [], showSystem, ACTIVITY_LIMIT);
  return (
    <DashCard id="activity" title={t("dashboard.recentActivity")} right={<CardLink href="/audit">{t("dashboard.viewAll")}</CardLink>}>
      {lines.length === 0 ? (
        <CardNote>{t("dashboard.noActivity")}</CardNote>
      ) : (
        <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
          {lines.map((l, i) => (
            <div key={l.kind === "event" ? l.entry.id : `group-${l.group}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderTop: i > 0 ? "1px solid var(--c-bd)" : "none", fontSize: 13 }}>
              {l.kind === "group" ? <Bot size={13} color="var(--c-tx3)" aria-hidden style={{ flexShrink: 0 }} /> : <ScrollText size={13} color="var(--c-tx3)" aria-hidden style={{ flexShrink: 0 }} />}
              <span style={{ flex: 1, minWidth: 0, color: l.kind === "group" ? "var(--c-tx3)" : "var(--c-tx2)", overflowWrap: "anywhere" }}>
                {l.kind === "group"
                  ? (l.group === "mcp" ? t("dashboard.groupMcp", { n: l.count }) : t("dashboard.groupSystem", { n: l.count }))
                  : humanizeEvent(l.entry, t, user?.email)}
              </span>
              <span style={{ color: "var(--c-tx3)", fontSize: 11, whiteSpace: "nowrap" }}>{relativeTime(l.kind === "event" ? l.entry.createdAt : l.latest)}</span>
            </div>
          ))}
        </div>
      )}
      {(quietCount > 0 || showSystem) && (
        <div style={{ marginTop: 8 }}>
          <Btn variant="ghost" aria-pressed={showSystem} onClick={() => setShowSystem(!showSystem)}>
            {showSystem ? t("dashboard.hideSystem") : t("dashboard.showSystem")}
          </Btn>
        </div>
      )}
    </DashCard>
  );
}
