"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { allCommands, type ChecklistRow, type CoolifyChecklist } from "../lib/coolify-takeover";
import { formatDateTime } from "../lib/format-time";
import { Badge, Btn, SectionCard } from "./ui";
import { Checkbox, Select } from "./form";
import { CopyBtn } from "./copy-row";
import { useToast } from "./toast";

const STATE = {
  this_server: "coolifyTakeover.checklist.state.this_server",
  already_added: "coolifyTakeover.checklist.state.already_added",
  waiting: "coolifyTakeover.checklist.state.waiting",
  expired: "coolifyTakeover.checklist.state.expired",
  not_generated: "coolifyTakeover.checklist.state.not_generated",
} as const;
const TONE = { this_server: "lapis", already_added: "ok", waiting: "warn", expired: "danger", not_generated: "muted" } as const;

function Row({
  r,
  teams,
  checked,
  teamId,
  onCheck,
  onTeam,
  onRefresh,
  busy,
}: {
  r: ChecklistRow;
  teams: CoolifyChecklist["teams"];
  checked: boolean;
  teamId: string;
  onCheck: (on: boolean) => void;
  onTeam: (id: string) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <li style={{ borderTop: "1px solid var(--c-bd)", padding: "6px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 44 }}>
        {r.state === "not_generated" ? (
          <Checkbox checked={checked} onChange={onCheck} label={<span style={{ fontWeight: 600, color: "var(--c-tx)" }}>{r.name}</span>} />
        ) : (
          <span style={{ fontWeight: 600, fontSize: 13, color: "var(--c-tx)" }}>{r.name}</span>
        )}
        <span className="mono" style={{ fontSize: 12, color: "var(--c-tx3)", flex: "1 1 140px", overflowWrap: "anywhere" }}>
          {r.ip}
        </span>
        <Badge tone={TONE[r.state]}>{t(STATE[r.state])}</Badge>
        {r.state === "not_generated" && (
          <Select
            value={teamId}
            onChange={onTeam}
            options={teams.map((x) => ({ value: x.id, label: x.name }))}
            ariaLabel={`${t("coolifyTakeover.checklist.team")}: ${r.name}`}
            style={{ maxWidth: 200 }}
          />
        )}
        {r.state === "expired" && (
          <Btn variant="ghost" onClick={onRefresh} disabled={busy} aria-label={t("coolifyTakeover.checklist.refreshLabel", { name: r.name })}>
            {t("coolifyTakeover.checklist.refresh")}
          </Btn>
        )}
      </div>
      {r.state === "waiting" && r.installCommand && (
        <div style={{ marginLeft: 4, display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>
            {t("coolifyTakeover.checklist.runOn")} <code className="mono">{r.ssh}</code>
            {r.expiresAt ? ` · ${t("coolifyTakeover.checklist.expiresAt", { when: formatDateTime(r.expiresAt) })}` : ""}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <code className="mono" style={{ flex: "1 1 260px", fontSize: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "6px 10px", overflowWrap: "anywhere" }}>
              {r.installCommand}
            </code>
            <CopyBtn text={r.installCommand} label={t("coolifyTakeover.checklist.copyOne", { name: r.name })} />
          </div>
        </div>
      )}
    </li>
  );
}

/** "Add all Coolify servers": one row per Coolify server with its install command. Nothing runs by itself. */
export function CoolifyServersChecklist({ serverId }: { serverId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["coolify-servers", serverId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.coolifyServers(serverId), gcTime: 0, staleTime: 0 });
  const [off, setOff] = useState<Set<string>>(new Set());
  const [teamFor, setTeamFor] = useState<Record<string, string>>({});

  const generate = useMutation({
    mutationFn: (assignments: Array<{ coolifyServerId: string; teamId: string }>) => api.coolifyGenerateServers(serverId, assignments),
    onSuccess: (r) => qc.setQueryData(key, r),
    onError: (e) => toast((e as Error).message || t("coolifyTakeover.error.generic"), "error"),
  });
  const refresh = useMutation({
    mutationFn: (id: string) => api.reissueServerEnroll(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast((e as Error).message || t("coolifyTakeover.error.generic"), "error"),
  });

  if (!data) return null;
  const others = data.rows.filter((r) => r.state !== "this_server");
  const picked = others.filter((r) => r.state === "not_generated" && !off.has(r.coolifyServerId));
  const commands = allCommands(data.rows);
  const teamOf = (r: ChecklistRow) => teamFor[r.coolifyServerId] ?? r.teamId ?? data.teams[0]?.id ?? "";

  return (
    <SectionCard title={t("coolifyTakeover.checklist.title")} desc={t("coolifyTakeover.checklist.desc")}>
      {others.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t("coolifyTakeover.checklist.empty")}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {data.rows.map((r) => (
            <Row
              key={r.coolifyServerId}
              r={r}
              teams={data.teams}
              checked={!off.has(r.coolifyServerId)}
              teamId={teamOf(r)}
              onCheck={(on) =>
                setOff((s) => {
                  const next = new Set(s);
                  if (on) next.delete(r.coolifyServerId);
                  else next.add(r.coolifyServerId);
                  return next;
                })
              }
              onTeam={(id) => setTeamFor((m) => ({ ...m, [r.coolifyServerId]: id }))}
              onRefresh={() => r.tugraServerId && refresh.mutate(r.tugraServerId)}
              busy={refresh.isPending}
            />
          ))}
        </ul>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {picked.length > 0 && (
          <Btn loading={generate.isPending} onClick={() => generate.mutate(picked.map((r) => ({ coolifyServerId: r.coolifyServerId, teamId: teamOf(r) })))}>
            {generate.isPending ? t("coolifyTakeover.checklist.generating") : t("coolifyTakeover.checklist.generate", { n: picked.length })}
          </Btn>
        )}
        {commands && <CopyBtn text={commands} label={t("coolifyTakeover.checklist.copyAll")} />}
      </div>
    </SectionCard>
  );
}
