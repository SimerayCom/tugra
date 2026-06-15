"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ServerView } from "../lib/types";
import { relativeTime, statusCounts, writableIds } from "../lib/fleet";
import { Badge, Btn, StatusDot } from "./ui";

const TEAM_COLORS = ["#C9A84C", "#3D6FE5", "#2FBF71", "#E5484D", "#A855F7", "#F5A524"];
function teamColor(teamId: string): string {
  let h = 0;
  for (const c of teamId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TEAM_COLORS[h % TEAM_COLORS.length];
}

export function ServerTable({ servers }: { servers: ServerView[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const counts = useMemo(() => statusCounts(servers), [servers]);
  const writable = writableIds(servers, selected);
  const skipped = selected.size - writable.length;

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
      <div style={{ display: "flex", gap: 14, marginBottom: 14, fontSize: 12, color: "var(--c-tx2)" }}>
        <span>● {counts.ONLINE} online</span>
        <span style={{ color: "var(--c-am)" }}>● {counts.PENDING} pending</span>
        <span style={{ color: "var(--c-r)" }}>● {counts.OFFLINE} offline</span>
        <span style={{ color: "var(--c-tx3)" }}>· {servers.length} total (tüm takımlar)</span>
      </div>

      <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--c-sb)", color: "var(--c-tx3)", textAlign: "left" }}>
              <th style={{ ...cell, width: 36 }}></th>
              <th style={cell}>Server</th>
              <th style={cell}>Team</th>
              <th style={cell}>Role</th>
              <th style={cell}>Last seen</th>
              <th style={{ ...cell, width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr
                key={s.id}
                style={{
                  borderTop: "1px solid var(--c-bd)",
                  opacity: s.canWrite ? 1 : 0.6,
                }}
              >
                <td style={cell}>
                  <input
                    type="checkbox"
                    disabled={!s.canWrite}
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    title={s.canWrite ? "" : "read-only (VIEWER)"}
                  />
                </td>
                <td style={cell}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <StatusDot status={s.status} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>
                        {s.hostname ?? "—"}
                      </div>
                    </div>
                  </div>
                </td>
                <td style={cell}>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 6,
                      background: `${teamColor(s.teamId)}22`,
                      color: teamColor(s.teamId),
                      fontWeight: 600,
                    }}
                  >
                    {s.teamId.slice(0, 6)}
                  </span>
                </td>
                <td style={cell}>
                  <Badge tone={s.canWrite ? "gold" : "muted"}>{s.role}</Badge>
                </td>
                <td style={{ ...cell, color: "var(--c-tx3)" }}>{relativeTime(s.lastSeenAt)}</td>
                <td style={cell}>
                  <Link href={`/servers/${s.id}`} style={{ color: "var(--c-lapis)", fontSize: 12, textDecoration: "none" }}>
                    View →
                  </Link>
                </td>
              </tr>
            ))}
            {servers.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...cell, textAlign: "center", color: "var(--c-tx3)", padding: 40 }}>
                  Henüz sunucu yok. <Link href="/servers/new" style={{ color: "var(--c-a)" }}>Sunucu ekle →</Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div
          style={{
            position: "sticky",
            bottom: 16,
            marginTop: 16,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 16px",
            background: "var(--c-sb)",
            border: "1px solid var(--c-a)",
            borderRadius: "var(--r2)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {writable.length} seçili
            {skipped > 0 && (
              <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}> ({skipped} salt-okunur atlandı)</span>
            )}
          </span>
          <div style={{ flex: 1 }} />
          {["Tümünü Güncelle", "Restart", "Deploy"].map((a) => (
            <Btn
              key={a}
              variant="ghost"
              onClick={() => alert(`${a}: bulk işlem motoru yakında (Faz 2).`)}
              disabled={writable.length === 0}
            >
              {a}
            </Btn>
          ))}
        </div>
      )}
    </div>
  );
}
