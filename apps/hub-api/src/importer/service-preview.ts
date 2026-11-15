import { analyzeService, ns } from "./import-planner";
import { transformServiceCompose } from "./import-service-map";
import type { ForeignService, ServiceBundle } from "./foreign-fleet";
import type { ServiceChoice } from "./dto";

/**
 * One service's review card: what the import would do for it, given the operator's choices and (when the token can read
 * them) the live variables and config files. Built by the SAME pure transform the apply runs, so the preview cannot drift
 * from the apply. NEVER carries a value or a file's content: variable NAMES, compose service keys, volume keys, hostnames
 * and fixed reasons only.
 */
export interface ServicePreview {
  itemRef: string;
  name: string;
  /** The source server's display name, when the source gave one (Coolify names its own host `localhost`). */
  sourceServer?: string;
  verdict: "importable" | "partial" | "skipped";
  compat: "template" | "passthrough" | "blocked";
  members: Array<{ name: string; status: "kept" | "dropped"; reason?: string }>;
  env: { resolved: string[]; missing: string[]; secretsAvailable: boolean };
  domains: Array<{ service: string; hostname: string; port: number }>;
  domainHints: Array<{ service: string; port: number }>;
  volumes: Array<{ key: string; origin: "named" | "host-bind"; policy: "copy" | "empty" | "skip"; dataPlane: string; mounts: Array<{ service: string; path: string }> }>;
  files: { needed: string[]; available: string[] };
  notCarried: Array<{ field: string; reason: string; level: "warn" | "info" }>;
  blockers: Array<{ code: string; message: string }>;
  floating: string[];
  pinned: string[];
  hold: boolean;
}

export function buildServicePreview(svc: ForeignService, choice: ServiceChoice | undefined, bundle: ServiceBundle | undefined): ServicePreview {
  const a = analyzeService(svc);
  const itemRef = ns("service", svc.serverRef, svc.sourceRef);
  const blockers = a.risks.filter((r) => r.level === "blocker").map((r) => ({ code: r.code, message: r.message }));
  if (!svc.composeFile) {
    return { itemRef, name: choice?.name ?? svc.name, ...(svc.serverName ? { sourceServer: svc.serverName } : {}), verdict: "skipped", compat: "blocked", members: [], env: { resolved: [], missing: [], secretsAvailable: false }, domains: [], domainHints: [], volumes: [], files: { needed: [], available: [] }, notCarried: [], blockers, floating: [], pinned: [], hold: false };
  }
  const r = transformServiceCompose({ svc, raw: svc.composeFile, bundle: bundle ? { values: bundle.values, files: bundle.files } : undefined, choice });
  const kept = new Set(r.membersKept);
  const droppedBy = new Map(r.membersDropped.map((m) => [m.name, m.reason]));
  const memberNames = [...new Set([...(svc.members ?? []).map((m) => m.name), ...r.membersKept, ...r.membersDropped.map((m) => m.name)])].sort();
  const verdict = choice?.skip ? "skipped" : r.verdict;
  return {
    itemRef,
    name: choice?.name ?? svc.name,
    ...(svc.serverName ? { sourceServer: svc.serverName } : {}),
    verdict,
    compat: verdict === "skipped" ? "blocked" : a.compat,
    members: memberNames.map((n) => (kept.has(n) ? { name: n, status: "kept" as const } : { name: n, status: "dropped" as const, reason: droppedBy.get(n) ?? "not part of the imported compose" })),
    env: { resolved: Object.keys(r.env).sort(), missing: bundle ? r.missingEnv : r.unverifiedKeys, secretsAvailable: !!bundle },
    domains: r.domains,
    domainHints: r.domainHints,
    volumes: r.volumes.map((v) => ({ key: v.key, origin: v.origin, policy: v.policy, dataPlane: v.dataPlane, mounts: v.mounts })),
    files: { needed: r.neededFiles, available: r.configMounts.map((m) => `${m.serviceName}:${m.target}`).sort() },
    notCarried: r.dropped.map((d) => ({ field: d.field, reason: d.reason, level: d.level })),
    blockers: [...blockers, ...(r.gate !== "ok" && blockers.length === 0 ? [{ code: "service.gate", message: `refused by the safety gate (${r.gate.code})` }] : [])],
    floating: r.floating,
    pinned: r.pinned,
    hold: r.hold,
  };
}
