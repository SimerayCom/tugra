"use client";

import type { ReactNode } from "react";
import { useT } from "../i18n/provider";
import { Card } from "./ui";
import { Select } from "./form";
import { MeterBar } from "./meter-bar";
import { fmtBytes } from "../lib/fleet";
import { metricTone } from "../lib/fleet-view";
import { backupSummary, serverStatusSummary, storageSummary, uptimeParts } from "../lib/home-mode";
import type { WidgetId } from "../lib/home-layout";
import type { Database, MetricsSample, ServerView } from "../lib/types";

function Widget({ title, value, detail, children }: { title: string; value: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <Card style={{ padding: 14, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
      {detail && <div style={{ fontSize: 12, color: "var(--c-tx2)", marginTop: 4 }}>{detail}</div>}
      {children}
    </Card>
  );
}

/**
 * At-a-glance tiles above the app grid: how many servers are up, disk use, backup coverage and uptime.
 * Storage and uptime follow the picked server; servers and backups are install-wide. Each tile can be hidden.
 */
export function HomeWidgets({
  enabled,
  servers,
  databases,
  selected,
  sample,
}: {
  enabled: Record<WidgetId, boolean>;
  servers: Pick<ServerView, "status">[];
  databases: Pick<Database, "backupSupported" | "backupEnabled">[];
  selected: Pick<ServerView, "uptimeSeconds"> | null;
  sample: MetricsSample | undefined;
}) {
  const t = useT();
  const status = serverStatusSummary(servers);
  const storage = storageSummary(sample);
  const backups = backupSummary(databases);
  const up = uptimeParts(selected?.uptimeSeconds);
  const attention = status.offline + status.pending;
  const uptimeText = up
    ? up.days > 0
      ? t("home.uptimeDaysHours", { d: up.days, h: up.hours })
      : up.hours > 0
        ? t("home.uptimeHoursMinutes", { h: up.hours, m: up.minutes })
        : t("home.uptimeMinutes", { m: up.minutes })
    : "—";
  const cards: ReactNode[] = [];
  if (enabled.servers && status.total > 0) {
    cards.push(
      <Widget
        key="servers"
        title={t("home.widgetServers")}
        value={t("home.widgetServersOnline", { online: status.online, total: status.total })}
        detail={attention > 0 ? t("home.widgetServersAttention", { n: attention }) : undefined}
      />,
    );
  }
  if (enabled.storage) {
    cards.push(
      <Widget
        key="storage"
        title={t("home.widgetStorage")}
        value={storage ? `${Math.round(storage.pct)}%` : "—"}
        detail={storage ? t("home.widgetStorageUsed", { used: fmtBytes(storage.used), total: fmtBytes(storage.total) }) : t("home.noData")}
      >
        {storage && (
          <div style={{ marginTop: 8 }}>
            <MeterBar grow value={storage.pct} tone={metricTone(storage.pct)} text={`${Math.round(storage.pct)}%`} label={t("home.widgetStorage")} showToneIcon />
          </div>
        )}
      </Widget>,
    );
  }
  if (enabled.backups) {
    cards.push(
      <Widget
        key="backups"
        title={t("home.widgetBackups")}
        value={backups.total > 0 ? `${backups.protected}/${backups.total}` : "—"}
        detail={backups.total > 0 ? t("home.widgetBackupsOn", { on: backups.protected, total: backups.total }) : t("home.widgetBackupsNone")}
      />,
    );
  }
  if (enabled.uptime) {
    cards.push(<Widget key="uptime" title={t("home.widgetUptime")} value={uptimeText} detail={up ? undefined : t("home.noData")} />);
  }
  if (cards.length === 0) return null;
  return (
    <div role="group" aria-label={t("home.widgets")} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", marginBottom: 20 }}>
      {cards}
    </div>
  );
}

/** Which server the gauges and widgets describe. Only shown when there is a real choice. */
export function GaugeServerPicker({ servers, value, onChange }: { servers: Pick<ServerView, "id" | "name">[]; value: string; onChange: (id: string) => void }) {
  const t = useT();
  if (servers.length < 2) return null;
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 12, color: "var(--c-tx2)", flexWrap: "wrap" }}>
      <span>{t("home.gaugeServer")}</span>
      <Select
        value={value}
        onChange={onChange}
        ariaLabel={t("home.gaugeServer")}
        options={servers.map((s) => ({ value: s.id, label: s.name }))}
        style={{ width: "auto", minWidth: 180, maxWidth: "100%" }}
      />
    </label>
  );
}
