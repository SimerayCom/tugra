"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Server as ServerIcon, Package, Database as DbIcon } from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import type { TerminalTarget } from "../lib/ws";
import { TextInput } from "./form";
import { Spinner } from "./ui";

interface Row {
  key: string;
  label: string;
  sub?: string;
  icon: typeof ServerIcon;
  target: TerminalTarget;
}

/**
 * Unified, searchable target list for the full-page terminal: every server (host shell), plus apps and
 * databases (their container). Compose apps are opened from their own page (they need a per-service
 * container pick), so they're left out here. Picking a target hands back a TerminalTarget.
 */
export function TerminalTargetPicker({ onPick }: { onPick: (t: TerminalTarget) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const databases = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases() });
  const loading = servers.isLoading || apps.isLoading || databases.isLoading;

  const groups: { title: string; rows: Row[] }[] = [
    {
      title: t("terminal.groupServers"),
      rows: (servers.data ?? []).map((s) => ({
        key: `server:${s.id}`,
        label: s.name,
        sub: s.status !== "ONLINE" ? t("terminal.offline") : (s.hostname ?? undefined),
        icon: ServerIcon,
        target: { server: s.id } as TerminalTarget,
      })),
    },
    {
      title: t("terminal.groupApps"),
      // Compose apps need a per-service container pick (done from the app page), so skip them here.
      rows: (apps.data ?? []).filter((a) => a.source !== "COMPOSE").map((a) => ({
        key: `app:${a.id}`,
        label: a.name,
        sub: a.domain ?? undefined,
        icon: Package,
        target: { app: a.id } as TerminalTarget,
      })),
    },
    {
      title: t("terminal.groupDatabases"),
      rows: (databases.data ?? []).map((d) => ({
        key: `database:${d.id}`,
        label: d.name,
        sub: d.engine,
        icon: DbIcon,
        target: { database: d.id } as TerminalTarget,
      })),
    },
  ];

  const needle = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, rows: needle ? g.rows.filter((r) => r.label.toLowerCase().includes(needle) || (r.sub ?? "").toLowerCase().includes(needle)) : g.rows }))
    .filter((g) => g.rows.length > 0);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", width: "100%" }}>
      <div style={{ marginBottom: 14 }}>
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("terminal.filterTargets")} aria-label={t("terminal.filterTargets")} />
      </div>
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 24 }}><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)", textAlign: "center", padding: 24 }}>{t("terminal.noTargets")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {filtered.map((g) => (
            <div key={g.title}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: 0.4, margin: "0 0 6px 4px" }}>{g.title}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {g.rows.map((r) => {
                  const Icon = r.icon;
                  return (
                    <button
                      key={r.key}
                      onClick={() => onPick(r.target)}
                      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", padding: "9px 12px", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}
                    >
                      <Icon size={15} aria-hidden style={{ color: "var(--c-tx3)", flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
                      {r.sub && <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
