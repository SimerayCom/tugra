"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { EntityDot } from "./entity-identity";

/** The project's identity colour, resolved from the shared ['projects'] query (null when none / unknown). */
export function useProjectColor(projectId: string | null | undefined): string | null {
  const { data = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects(), enabled: !!projectId });
  if (!projectId) return null;
  return data.find((p) => p.id === projectId)?.color ?? null;
}

/** Colour dot for a project (nothing when it has no colour); the project name beside it carries the meaning. */
export function ProjectDot({ projectId }: { projectId: string | null | undefined }) {
  const color = useProjectColor(projectId);
  return color ? <EntityDot color={color} /> : null;
}
