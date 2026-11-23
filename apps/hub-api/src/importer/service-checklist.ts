import type { ForeignService } from "./foreign-fleet";
import type { ServiceChoice } from "./dto";
import type { ServiceTransformResult } from "./import-service-map";

/**
 * The post-import checklist for ONE imported service: what the operator still has to do before the stopped app can
 * safely be deployed. Pure and deterministic. Items carry only a kind, a severity and short params (compose service keys,
 * volume keys, hostnames, a network name and an alias): the web renders each kind through its own i18n key, so no
 * source-supplied free text, no secret and no file content can reach the screen.
 */
export type ChecklistKind =
  | "deploy-after-data"
  | "data-step"
  | "quiesce"
  | "dns"
  | "tunnel"
  | "repoint-dependents"
  | "unpinned-image"
  | "not-carried"
  | "reach";

export interface ChecklistItem {
  kind: ChecklistKind;
  severity: "info" | "warn";
  params: Record<string, string | number | string[]>;
}

export interface ChecklistOutcome {
  /** The private network the importer attached the service to (D2: composeNetworks), if it did. */
  network?: { network: string; alias: string };
  /** The target server's public IP, when known (for the DNS item). */
  targetIp?: string;
}

export function buildServiceChecklist(
  svc: ForeignService,
  res: ServiceTransformResult,
  choice: ServiceChoice | undefined,
  outcome: ChecklistOutcome = {},
): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  const name = choice?.name ?? svc.name;
  // a volume the service does not carry (an object store's, moved through Object migration) is no data step
  const copy = res.volumes.filter((v) => v.policy === "copy" && v.dataPlane !== "not-carried");

  // Nothing is deployed by the import. Always the first item.
  out.push({ kind: "deploy-after-data", severity: "warn", params: { name } });

  if (copy.length) {
    out.push({ kind: "data-step", severity: "warn", params: { volumes: copy.map((v) => v.key), manualLarge: copy.filter((v) => v.dataPlane === "manual-large").map((v) => v.key) } });
    // A live copy of an embedded-DB data directory (Meilisearch LMDB, MinIO `.minio.sys`) is not crash-consistent.
    const members = [...new Set(copy.flatMap((v) => v.mounts.map((m) => m.service)))].sort();
    out.push({ kind: "quiesce", severity: "info", params: { members } });
  }

  if (res.domains.length) {
    out.push({ kind: "dns", severity: "warn", params: { hosts: [...new Set(res.domains.map((d) => d.hostname))].sort(), ...(outcome.targetIp ? { targetIp: outcome.targetIp } : {}) } });
  }

  if (res.hold) out.push({ kind: "tunnel", severity: "warn", params: { name } });

  const internalOnly = res.domains.length === 0 && !res.hold;
  if (internalOnly) {
    out.push({ kind: "reach", severity: "info", params: outcome.network ? { network: outcome.network.network, alias: outcome.network.alias } : { manual: 1 } });
    out.push({ kind: "repoint-dependents", severity: "warn", params: { name } });
  }

  if (res.floating.length) out.push({ kind: "unpinned-image", severity: "warn", params: { services: [...res.floating].sort() } });

  const skipped = res.volumes.filter((v) => v.policy === "skip").map((v) => v.key);
  if (res.membersDropped.length || skipped.length) {
    out.push({ kind: "not-carried", severity: "warn", params: { members: res.membersDropped.map((m) => m.name), volumes: skipped } });
  }
  return out;
}
