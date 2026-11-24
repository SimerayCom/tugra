"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { Server } from "lucide-react";
import { limitRows, realHostname, sortServersProblemsFirst } from "../../lib/dashboard-lists";
import type { FleetRow } from "../../lib/fleet-view";
import type { ServerStatus } from "../../lib/types";
import { statusLabel } from "../../lib/status";
import { useT } from "../../i18n/provider";
import { Btn, EmptyState, StatusPill } from "../ui";
import { ErrorState } from "../error-state";
import { ListCard, ListRow } from "../list";
import { DashCard, SeeAll } from "./dash-card";

const serverColor = (s: ServerStatus) => (s === "ONLINE" ? "var(--c-g)" : s === "PENDING" ? "var(--c-am)" : "var(--c-r)");
const logoBox: CSSProperties = {
  width: 40, height: 40, borderRadius: 9, background: "var(--c-tile)",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};

/** Servers, ones that need a look first. Each row shows the display name and, underneath, the machine's real host
 *  name (never a leftover container id). */
export function ServersCard({ rows, down, onRetry }: { rows: FleetRow[]; down: boolean; onRetry: () => void }) {
  const t = useT();
  const sorted = sortServersProblemsFirst(rows);
  const { shown, total } = limitRows(sorted);
  return (
    <DashCard id="servers" title={t("dashboard.servers")} right={<SeeAll href="/servers" total={total} shown={shown.length} />}>
      <ListCard>
        {shown.map(({ server: s }, i) => {
          const host = realHostname(s);
          return (
            <ListRow key={s.id} index={i} href={`/servers/${s.id}`} style={{ padding: "11px 16px" }}>
              <span style={logoBox}><Server size={18} color="var(--c-a)" aria-hidden /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>{s.name}</div>
                {host && <div className="mono" title={t("dashboard.serverHostname", { name: host })} style={{ fontSize: 11, color: "var(--c-tx3)", overflowWrap: "anywhere" }}>{host}</div>}
              </div>
              <StatusPill label={statusLabel(t, s.status)} color={serverColor(s.status)} />
            </ListRow>
          );
        })}
        {down ? (
          <ErrorState onRetry={onRetry} />
        ) : rows.length === 0 && (
          <EmptyState icon={Server} title={t("dashboard.noServersTitle")} action={<Link href="/servers/new"><Btn>{t("dashboard.addServer")}</Btn></Link>}>
            {t("dashboard.noServers")}
          </EmptyState>
        )}
      </ListCard>
    </DashCard>
  );
}
