"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Server } from "lucide-react";
import type { ServerView, ServerStatus } from "../lib/types";
import { relativeTime, statusCounts, writableIds, teamLabel, filterByStatus } from "../lib/fleet";
import { clickedInteractive } from "../lib/row-nav";
import { useT } from "../i18n/provider";
import { Badge, Btn, EmptyState, StatusDot } from "./ui";
import { TagChips } from "./tags";
import { BulkRunModal } from "./bulk-run-modal";
import { CleanupBulkModal } from "./cleanup-bulk-modal";
import { PatchBulkModal } from "./patch-bulk-modal";

const TEAM_COLORS = ["#C9A84C", "#3D6FE5", "#2FBF71", "#E5484D", "#A855F7", "#F5A524"];
function teamColor(teamId: string): string {
  let h = 0;
  for (const c of teamId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TEAM_COLORS[h % TEAM_COLORS.length];
}

export function ServerTable({
  servers,
  teams = [],
  status = null,
  onStatusChange,
}: {
  servers: ServerView[];
  teams?: { id: string; name: string }[];
  status?: ServerStatus | null;
  onStatusChange?: (s: ServerStatus | null) => void;
}) {
  const t = useT();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulk, setShowBulk] = useState(false);
  const [showCleanup, setShowCleanup] = useState(false);
  const [showPatch, setShowPatch] = useState(false);
  const counts = useMemo(() => statusCounts(servers), [servers]);
  const rows = filterByStatus(servers, status);
  const writable = writableIds(servers, selected);
  const skipped = selected.size - writable.length;

  const statusChip = (s: ServerStatus | null, label: string, color: string) => {
    const active = status === s;
    return (
      <button
        type="button"
        onClick={() => onStatusChange?.(s)}
        style={{ fontFamily: "inherit", fontSize: 12, cursor: "pointer", border: "1px solid", borderColor: active ? color : "var(--c-bd)", background: active ? `${color}22` : "transparent", color, borderRadius: 999, padding: "3px 11px" }}
      >
        {label}
      </button>
    );
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cell: React.CSSProperties = { padding: "10px 14px", fontSize: 13 };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {statusChip(null, t("servers.total", { n: servers.length }), "var(--c-tx3)")}
        {statusChip("ONLINE", `● ${t("servers.online", { n: counts.ONLINE })}`, "var(--c-g)")}
        {statusChip("PENDING", `● ${t("servers.pending", { n: counts.PENDING })}`, "var(--c-am)")}
        {statusChip("OFFLINE", `● ${t("servers.offline", { n: counts.OFFLINE })}`, "var(--c-r)")}
      </div>

      <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--c-sb)", color: "var(--c-tx3)", textAlign: "left" }}>
              <th style={{ ...cell, width: 36 }}></th>
              <th style={cell}>{t("servers.server")}</th>
              <th style={cell}>{t("servers.team")}</th>
              <th style={cell}>{t("servers.access")}</th>
              <th style={cell}>{t("servers.lastSeen")}</th>
              <th style={{ ...cell, width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr
                key={s.id}
                className="row-link"
                onClick={(e) => { if (!clickedInteractive(e)) router.push(`/servers/${s.id}`); }}
                style={{ borderTop: "1px solid var(--c-bd)", opacity: s.canWrite ? 1 : 0.6 }}
              >
                <td style={cell}>
                  <input type="checkbox" disabled={!s.canWrite} checked={selected.has(s.id)} onChange={() => toggle(s.id)} title={s.canWrite ? "" : t("servers.readonly")} />
                </td>
                <td style={cell}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <StatusDot status={s.status} />
                    <div>
                      <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                        <Link href={`/servers/${s.id}`} style={{ color: "var(--c-tx)", textDecoration: "none" }}>{s.name}</Link>
                        <TagChips tags={s.tags} />
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{s.hostname ?? "—"}</div>
                    </div>
                  </div>
                </td>
                <td style={cell}>
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: `${teamColor(s.teamId)}22`, color: teamColor(s.teamId), fontWeight: 600 }}>
                    {teamLabel(teams, s.teamId)}
                  </span>
                </td>
                <td style={cell}>
                  {!s.canWrite && <Badge tone="muted">{t("servers.readOnly")}</Badge>}
                </td>
                <td style={{ ...cell, color: "var(--c-tx3)" }}>{relativeTime(s.lastSeenAt)}</td>
                <td style={cell}>
                  <Link href={`/servers/${s.id}`} style={{ color: "var(--c-lapis)", fontSize: 12, textDecoration: "none" }}>{t("servers.view")}</Link>
                </td>
              </tr>
            ))}
            {servers.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...cell, padding: 0 }}>
                  <EmptyState
                    icon={Server}
                    title={t("servers.emptyTitle")}
                    action={<Link href="/servers/new"><Btn>{t("servers.emptyAdd")}</Btn></Link>}
                  >
                    {t("servers.empty")}
                  </EmptyState>
                </td>
              </tr>
            )}
            {servers.length > 0 && rows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...cell, textAlign: "center", color: "var(--c-tx3)", padding: 24 }}>{t("servers.noMatch")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div style={{ position: "sticky", bottom: 16, marginTop: 16, display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: "var(--c-sb)", border: "1px solid var(--c-a)", borderRadius: "var(--r2)", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {t("servers.selected", { n: writable.length })}
            {skipped > 0 && <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}> {t("servers.skipped", { n: skipped })}</span>}
          </span>
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" onClick={() => setShowPatch(true)} disabled={writable.length === 0}>
            {t("bulk.applyPatch")}
          </Btn>
          <Btn variant="ghost" onClick={() => setShowCleanup(true)} disabled={writable.length === 0}>
            {t("bulk.applyCleanup")}
          </Btn>
          <Btn onClick={() => setShowBulk(true)} disabled={writable.length === 0}>
            {t("bulk.runCommand")}
          </Btn>
        </div>
      )}

      {showBulk && (
        <BulkRunModal servers={servers} selectedIds={[...selected]} onClose={() => setShowBulk(false)} />
      )}
      {showCleanup && (
        <CleanupBulkModal servers={servers} selectedIds={[...selected]} onClose={() => setShowCleanup(false)} />
      )}
      {showPatch && (
        <PatchBulkModal servers={servers} selectedIds={[...selected]} onClose={() => setShowPatch(false)} />
      )}
    </div>
  );
}
