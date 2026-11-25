import { COMPOSE_PROJECT_RE, MAX_ADOPT_FILES, adoptPathProblem, foreignProjectDir } from "../deploy/compose-adopt";
import { foreignPlatform, type ForeignPlatform, type ParsedContainer } from "./discover-script";

/**
 * Compose projects found on a host, judged for "adopt the whole stack in place". Pure: it reads the parsed discover rows
 * (one `docker inspect` per container) and decides, per project, whether Tugra may take it over and what it would take:
 * the project name, working directory and config-file paths come straight from docker's own compose labels.
 */

export type StackRefusal =
  | "tugra" // part of Tugra's own install, or a Tugra-deployed compose app
  | "managed" // Coolify / Dokploy runs it
  | "no_config" // the containers carry no working dir / config files label (not started by `docker compose`, or a very old one)
  | "unsafe_path" // a path Tugra will not mount (system root, odd characters, too shallow)
  | "bad_name" // a project name compose could not have produced
  | "name_clash"; // another container's name starts with `<project>-`: name-based health / metrics could not tell them apart

export interface StackService {
  service: string;
  image: string;
  /** Published host ports. */
  ports: number[];
  state: string;
  containers: number;
}

export interface StackVolume {
  service: string;
  name: string;
  target: string;
}

export interface DiscoveredStack {
  project: string;
  workingDir: string | null;
  configFiles: string[];
  services: StackService[];
  volumes: StackVolume[];
  /** The first member row in the adopt table: the "Adopt stack" button sits on it. */
  firstContainer: string;
  adoptable: boolean;
  reason: StackRefusal | null;
  managedBy: ForeignPlatform | null;
}

const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** `config_files` label → paths (docker joins them with commas). null when the label is absent or empty. */
export function splitConfigFiles(label: string | null): string[] | null {
  if (!label) return null;
  const parts = label.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

export function analyzeStacks(all: ParsedContainer[]): DiscoveredStack[] {
  const projects = new Map<string, ParsedContainer[]>();
  for (const c of all) {
    if (!c.composeProject) continue;
    (projects.get(c.composeProject) ?? projects.set(c.composeProject, []).get(c.composeProject)!).push(c);
  }
  const out: DiscoveredStack[] = [];
  for (const [project, members] of projects) {
    const visible = members.filter((m) => !m.isTugra);
    if (visible.length === 0) continue; // Tugra's own stack: never listed at all (the discover rows hide it too)

    const svc = new Map<string, StackService>();
    const volumes: StackVolume[] = [];
    for (const m of visible) {
      const key = m.composeService ?? m.name;
      const e = svc.get(key) ?? { service: key, image: m.image, ports: [], state: m.state, containers: 0 };
      e.containers++;
      if (m.state === "running") e.state = "running";
      for (const p of m.ports) if (p.host != null && !e.ports.includes(p.host) && e.ports.length < 20) e.ports.push(p.host);
      svc.set(key, e);
      for (const mt of m.mounts) {
        if (mt.type !== "volume" || !VOLUME_NAME_RE.test(mt.source) || !mt.target.startsWith("/")) continue;
        if (volumes.length < 60 && !volumes.some((v) => v.service === key && v.name === mt.source && v.target === mt.target)) volumes.push({ service: key, name: mt.source, target: mt.target });
      }
    }

    // First non-null label wins (every member of one project carries the same working dir / config files).
    const workingDir = visible.find((m) => m.composeWorkingDir)?.composeWorkingDir ?? null;
    const configFiles = splitConfigFiles(visible.find((m) => m.composeConfigFiles)?.composeConfigFiles ?? null) ?? [];
    const managedBy =
      members.map((m) => m.managedBy ?? foreignPlatform({ name: m.name, image: m.image, labelKeys: m.labelKeys })).find((p) => p !== null) ??
      (workingDir ? foreignProjectDir(workingDir) : null);

    let reason: StackRefusal | null = null;
    if (members.some((m) => m.tugraReason !== null)) reason = "tugra";
    else if (managedBy) reason = "managed";
    else if (!COMPOSE_PROJECT_RE.test(project)) reason = "bad_name";
    else if (!workingDir || configFiles.length === 0) reason = "no_config";
    else if (configFiles.length > MAX_ADOPT_FILES || adoptPathProblem(workingDir) !== null || configFiles.some((f) => adoptPathProblem(f) !== null)) reason = "unsafe_path";
    else if (all.some((c) => c.composeProject !== project && (c.name === project || c.name.startsWith(`${project}-`)))) reason = "name_clash";

    out.push({
      project,
      workingDir,
      configFiles,
      services: [...svc.values()].sort((a, b) => a.service.localeCompare(b.service)),
      volumes,
      firstContainer: visible[0].name,
      adoptable: reason === null,
      reason,
      managedBy,
    });
  }
  return out;
}

/** The refusal sentence for a 400. */
export function stackRefusalMessage(reason: StackRefusal, managedBy: ForeignPlatform | null): string {
  switch (reason) {
    case "tugra":
      return "this compose project is part of Tugra and can't be adopted";
    case "managed": {
      const p = managedBy === "dokploy" ? "Dokploy" : "Coolify";
      return `this compose project is managed by ${p}; move it with the ${p} import`;
    }
    case "no_config":
      return "this compose project doesn't record its working directory and config files, so Tugra can't run it later";
    case "unsafe_path":
      return "this compose project lives in a location Tugra can't mount safely (system directory, spaces or special characters in the path)";
    case "bad_name":
      return "this compose project's name can't be used";
    case "name_clash":
      return "another container on this server has a name starting with this project's name, so the stack can't be told apart from it; rename the project first";
  }
}
