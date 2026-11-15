import { composeProject } from "../deploy/compose-script";

/**
 * The hub-resolved container selector of a drain. A container matches iff its name is in `names`, OR starts with
 * any `prefixes` entry, OR starts with a `svcPrefixes` entry followed ONLY by ASCII digits (a compose replica
 * index, so service `web` never swallows `web-2`), OR matches a glob. The agent evaluates exactly this (see
 * agent/internal/drains/match.go); both implementations are pinned by agent/internal/drains/testdata/match_cases.json.
 */
export interface DrainMatch {
  names: string[];
  prefixes: string[];
  svcPrefixes: string[];
  globs: string[];
}

/** Resolve an app drain's selector. No service filter = every container of the app: the classic container
 *  (`tugra_<id>`), its rollout twin (`__rollout`), compose services (`tugra_<id>-<svc>-<n>`) and swarm tasks
 *  (`tugra_<id>.<slot>.<task>`). The `.` prefix is always included (the agent cannot see clusterId); the
 *  delimiter makes it safe because ids are alphanumeric, so `tugra_db_*`, `__prev` and sibling ids never match. */
export function resolveAppMatch(appId: string, services: string[]): DrainMatch {
  const P = composeProject({ id: appId });
  return services.length
    ? { names: [], prefixes: [], svcPrefixes: services.map((s) => `${P}-${s}-`), globs: [] }
    : { names: [P, `${P}__rollout`], prefixes: [`${P}-`, `${P}.`], svcPrefixes: [], globs: [] };
}

/** Server-wide glob filter (undefined = no filter = every tugra_ container, as before D7). */
export const resolveServerMatch = (globs: string[]): DrainMatch | undefined =>
  globs.length ? { names: [], prefixes: [], svcPrefixes: [], globs } : undefined;

/** Reference evaluation of a match (mirrors the agent; used by the shared-fixture spec). */
export function drainMatchAllows(m: DrainMatch, container: string): boolean {
  if (m.names.includes(container)) return true;
  if (m.prefixes.some((p) => p !== "" && container.startsWith(p))) return true;
  if (m.svcPrefixes.some((p) => p !== "" && container.startsWith(p) && /^\d+$/.test(container.slice(p.length)))) return true;
  return m.globs.some((g) => globMatch(g, container));
}

/** Minimal path.Match-compatible glob: `*` (any run, no `/`), `?` (one char). */
function globMatch(glob: string, s: string): boolean {
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
  return re.test(s);
}
