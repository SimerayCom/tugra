import type { Project } from "./types";

export interface EnvOption {
  value: string; // environmentId
  label: string; // "Project / environment"
  projectId: string;
}

/** Flatten projects → environment options ("Project / env") for resource pickers. */
export function envOptions(projects: Project[]): EnvOption[] {
  return projects.flatMap((p) =>
    p.environments.map((e) => ({ value: e.id, label: `${p.name} / ${e.name}`, projectId: p.id })),
  );
}
