"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { anyTeamHasCoolify, moveOffTeamIds } from "../lib/coolify-move";
import { useTeamScope } from "../components/team-scope";

/**
 * Whether the "Move off Coolify" entry belongs in the sidebar and ⌘K: a team in view (the scope, else every team the user owns or
 * administers) has a connected Coolify host or a server Coolify manages. Reads the same secret-free status route as the page; a team it
 * cannot read counts as having none. False until the answer is in, so the entry never flashes for an account without Coolify.
 */
export function useMoveOffVisible(): boolean {
  const { user } = useAuth();
  const { teamId: scope } = useTeamScope();
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams(), enabled: !!user, staleTime: 60_000 });
  const ids = moveOffTeamIds(Array.isArray(teams) ? teams : [], scope);
  const { data } = useQuery({
    queryKey: ["coolify-move-present", ids.join(",")],
    queryFn: () => anyTeamHasCoolify(ids, (id) => api.coolifyMoveStatus(id)),
    enabled: !!user && ids.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return data === true;
}
