/**
 * The field rules of the cutover (spec section 8), as PURE functions: what the in-place `Application` update changes
 * when an app flips from its source server to its target, the pre-image that makes it reversible, and the inverse.
 * Nothing here touches the database; the runner applies the patch inside its cutover transaction.
 */
import { cpusetExceedsTarget, gpuNotReadyOnTarget, hasPrivilegedGrant } from "./move-target-fit";
import { deriveTargetDomain } from "./move-preflight";
import { rebaseSelfUrls } from "./rebase-self-urls";
import type { MoveAckInput } from "./dto";

/** The slice of an Application row the cutover reads (and the only columns it may ever change). */
export interface CutoverAppRow {
  id: string;
  name: string;
  serverId: string;
  hostPort: number | null;
  domain: string | null;
  domainKind: string;
  composeFile: string | null;
  configMounts: unknown;
  templateSlug: string | null;
  source: string;
  cpusetCpus: string | null;
  gpus: string | null;
  clusterId: string | null;
  allowPrivilegedDockerOptions: boolean;
  dockerOptions: string | null;
}

export interface CutoverServerRow {
  id: string;
  publicIp: string | null;
  publicIpv6: string | null;
  wildcardDomain: string | null;
  magicSuffix: string | null;
  proxyBind: string;
  cpuCores: number | null;
  gpuInventory: unknown;
}

/** Every column the cutover can change. NEVER env*, cert key, webhook or credential columns. */
export const CUTOVER_COLUMNS = ["serverId", "hostPort", "domain", "domainKind", "composeFile", "configMounts", "cpusetCpus", "gpus", "allowPrivilegedDockerOptions", "dockerOptions"] as const;
export type CutoverColumn = (typeof CUTOVER_COLUMNS)[number];

export interface CutoverPlan {
  /** Column -> new value (always includes serverId). */
  data: Partial<Record<CutoverColumn, unknown>>;
  /** Column -> value BEFORE the cutover, for exactly the columns in `data`. */
  before: Partial<Record<CutoverColumn, unknown>>;
  /** True when the plain hostPort is busy on the target and must be reallocated (needs ack hostPortChanged). */
  needsHostPort: boolean;
  /** What the preflight/ack model says changed; used to sanity-check the acks at cutover time. */
  changes: { domain: boolean; compose: boolean; cpuset: boolean; gpus: boolean; privileged: boolean };
}

export interface CutoverInput {
  app: CutoverAppRow;
  source: Pick<CutoverServerRow, "id" | "publicIp">;
  target: CutoverServerRow;
  acks: Partial<MoveAckInput>;
  defaultMagicSuffix: string;
  /** Ports in use on the target RIGHT NOW (DB reservations + live probe). */
  targetUsedPorts: Set<number>;
  /** The free port to switch to when the host port is busy (null = none available). */
  newHostPort: number | null;
}

/** A required acknowledgement that is missing at cutover: the situation changed after the operator confirmed. */
export class CutoverAckMissing extends Error {
  constructor(public readonly ack: keyof MoveAckInput) {
    super(`acknowledgement missing at cutover: ${ack}`);
  }
}

export function planCutover(i: CutoverInput): CutoverPlan {
  const { app, target } = i;
  const data: CutoverPlan["data"] = { serverId: target.id };
  const before: CutoverPlan["before"] = { serverId: app.serverId };
  const set = (col: Exclude<CutoverColumn, "serverId">, value: unknown): void => {
    data[col] = value;
    before[col] = (app as unknown as Record<string, unknown>)[col] ?? null;
  };
  const changes = { domain: false, compose: false, cpuset: false, gpus: false, privileged: false };

  // hostPort: kept when free on the target; otherwise reallocated, which the operator must have acknowledged.
  let needsHostPort = false;
  if (app.hostPort != null && i.targetUsedPorts.has(app.hostPort)) {
    needsHostPort = true;
    if (!i.acks.hostPortChanged) throw new CutoverAckMissing("hostPortChanged");
    if (i.newHostPort == null) throw new Error("no free host port available on the target");
    set("hostPort", i.newHostPort);
  }

  // domain: a magic domain follows the target's address, keeping its label; custom domains are untouched.
  const dom = deriveTargetDomain(app, target, i.defaultMagicSuffix);
  if (app.domainKind === "magic" && dom.from !== dom.to) {
    if (!i.acks.domainChanges) throw new CutoverAckMissing("domainChanges");
    changes.domain = true;
    set("domain", dom.to);
    if (dom.dropped) set("domainKind", "none");
  }

  // template compose / config mounts bake the old magic domain + server ip: rebase them to the target's.
  if (app.templateSlug && app.source === "COMPOSE") {
    const r = rebaseSelfUrls(
      { composeFile: app.composeFile, configMounts: app.configMounts },
      { ip: i.source.publicIp, domain: dom.from },
      { ip: target.publicIp, domain: dom.to },
    );
    if (r.changed) {
      changes.compose = true;
      if (r.composeFile !== app.composeFile) set("composeFile", r.composeFile);
      if (JSON.stringify(r.configMounts) !== JSON.stringify(app.configMounts)) set("configMounts", r.configMounts);
    }
  }

  // host-bound settings the operator chose to drop.
  if (cpusetExceedsTarget(app.cpusetCpus, target.cpuCores)) {
    if (!i.acks.resetCpuset) throw new CutoverAckMissing("resetCpuset");
    changes.cpuset = true;
    set("cpusetCpus", null);
  }
  if (gpuNotReadyOnTarget(app, target.gpuInventory)) {
    if (!i.acks.dropGpus) throw new CutoverAckMissing("dropGpus");
    changes.gpus = true;
    set("gpus", null);
  }
  if (hasPrivilegedGrant(app)) {
    if (!i.acks.dropPrivilegedOptions) throw new CutoverAckMissing("dropPrivilegedOptions");
    changes.privileged = true;
    set("allowPrivilegedDockerOptions", false);
    set("dockerOptions", null);
  }
  return { data, before, needsHostPort, changes };
}

/** The Application.update payload that undoes a cutover: the pre-image of every changed column. */
export function restoreData(before: Partial<Record<CutoverColumn, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of CUTOVER_COLUMNS) {
    if (col in before) out[col] = before[col] ?? null;
  }
  return out;
}

/** True when `v` is a plausible snapshot (an object whose keys are all cutover columns). Defence against a corrupt row. */
export function isValidSnapshot(v: unknown): v is Partial<Record<CutoverColumn, unknown>> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => (CUTOVER_COLUMNS as readonly string[]).includes(k)) && "serverId" in (v as object);
}
