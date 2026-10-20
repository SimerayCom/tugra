"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Select } from "./form";
import { Badge } from "./ui";

const KEY = "tugra.teamScope";

const Ctx = createContext<{ teamId: string | null; setTeamId: (t: string | null) => void }>({
  teamId: null,
  setTeamId: () => {},
});

/** Global "which team am I looking at" scope (null = all teams). Persisted. */
export function TeamScopeProvider({ children }: { children: ReactNode }) {
  const [teamId, setState] = useState<string | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) setState(saved);
    } catch { /* storage unavailable */ }
  }, []);
  const setTeamId = (t: string | null) => {
    setState(t);
    try {
      if (t) localStorage.setItem(KEY, t);
      else localStorage.removeItem(KEY);
    } catch { /* storage unavailable */ }
  };
  return <Ctx.Provider value={{ teamId, setTeamId }}>{children}</Ctx.Provider>;
}

export const useTeamScope = () => useContext(Ctx);

/** Header control: filter the whole app to one team (or all). Hidden with a single team. */
export function TeamScopeSelect() {
  const t = useT();
  const { teamId, setTeamId } = useTeamScope();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });

  // A stale scope (left that team) falls back to "all teams".
  useEffect(() => {
    if (teamId && teams.length > 0 && !teams.some((tm) => tm.id === teamId)) setTeamId(null);
  }, [teamId, teams, setTeamId]);

  if (teams.length <= 1) return null;
  const ALL = "__all__";
  const value = teams.some((tm) => tm.id === teamId) ? (teamId as string) : ALL;

  return (
    <Select
      value={value}
      onChange={(v) => setTeamId(v === ALL ? null : v)}
      options={[{ value: ALL, label: t("nav.allTeams") }, ...teams.map((tm) => ({ value: tm.id, label: tm.name }))]}
      style={{ width: "auto", minWidth: 130, fontSize: 12, padding: "5px 8px" }}
    />
  );
}

/** Small badge naming the team an item belongs to (resolved from the ['teams'] query). */
export function TeamBadge({ teamId, teams }: { teamId: string; teams?: { id: string; name: string }[] }) {
  const { data = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams(), enabled: !teams });
  const name = (teams ?? data).find((tm) => tm.id === teamId)?.name;
  if (!name) return null;
  return <Badge tone="lapis">{name}</Badge>;
}
