import { createHash } from "node:crypto";
import type { AppSpec } from "./deploy-script";
import { flagsToken } from "../common/env-flags";

/**
 * A redacted, persistable snapshot of the config a deploy ran with — so the
 * Deployments view can show "what changed since the last deploy". SECRETS NEVER
 * ENTER THE SNAPSHOT: env values become short fingerprints (sha256 prefix) used
 * only for change detection, and git/registry credentials collapse to booleans.
 */
export interface ConfigSnapshot {
  /** Schema marker. 2 = records restartPolicy (always, even the default). Absent = an older snapshot that never did. */
  snapV?: number;
  source?: string;
  image?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  gitSubmodules?: boolean;
  gitLfs?: boolean;
  gitShallowClone?: boolean;
  disableBuildCache?: boolean;
  injectEnvAsBuildArgs?: boolean;
  sourceCommitMode?: string;
  buildType?: string;
  dockerfilePath?: string | null;
  baseDirectory?: string | null;
  buildCommand?: string | null;
  nixpacksInstallCmd?: string | null;
  nixpacksBuildCmd?: string | null;
  nixpacksStartCmd?: string | null;
  outputDir?: string | null;
  composeFile?: string | null;
  composePath?: string | null;
  healthCmd?: string | null;
  memoryMb?: number | null;
  cpus?: number | null;
  gpus?: string | null;
  // Extra classic-app limits. Emitted only when set (like the container-ops fields below) so a snapshot from before
  // they existed and one with them unset both read "—" and produce no spurious diff.
  memorySwapMb?: number | null;
  pidsLimit?: number | null;
  shmSizeMb?: number | null;
  cpuShares?: number | null;
  cpusetCpus?: string | null;
  replicas?: number | null;
  hostPort?: number | null;
  containerPort?: number | null;
  domain?: string | null;
  domainRedirect?: "www" | "root" | null;
  securityHeaders?: boolean;
  gzip?: boolean;
  // Container ops/networking. Each is emitted only when set (non-default), so a deploy from before the field
  // existed and one with it unset both read "—" and produce no spurious diff entry.
  restartPolicy?: string | null;
  restartMaxRetries?: number | null;
  stopGracePeriodSec?: number | null;
  drainSec?: number | null;
  containerAlias?: string | null;
  /** Extra user Docker networks (sorted; diffed as a set). */
  networks?: string[];
  /** Extra alias hostnames routed to the primary service (sorted; diffed as a set). */
  extraDomains?: string[];
  /** Per-service compose domains: hostname → the service + port it routes to (diffed by hostname). */
  serviceDomains?: { service: string; hostname: string; port: number }[];
  volumes: { name: string; path: string }[];
  /** config mount target → 12-hex fingerprint of its (placeholder) content — never stored verbatim. */
  configMounts?: { target: string; mode?: string; fp: string }[];
  /** env var name → 12-hex fingerprint of its value (value itself is never stored). */
  env: Record<string, string>;
  /** Per-variable flags: env var name -> readable token (build, build-only, literal, multiline, joined by +). Only keys
   *  with non-default flags; omitted when none. Flags are not secrets, so the token is stored verbatim. */
  envFlags?: Record<string, string>;
  /** Build-time flagged variable name -> 12-hex fingerprint of its build value (never the value). Omitted when none. */
  buildEnv?: Record<string, string>;
  hasGitToken: boolean;
  hasRegistryAuth: boolean;
}

export interface ConfigChange {
  field: string;
  kind: "added" | "removed" | "changed";
  before?: string;
  after?: string;
}

/** Placeholder shown for secret (env) values, which are never stored or revealed. */
const SECRET = "•••";

/** The scalar AppSpec fields that are safe to record verbatim and diff. */
const SCALAR_FIELDS = [
  "source",
  "image",
  "gitUrl",
  "gitBranch",
  "buildType",
  "dockerfilePath",
  "baseDirectory",
  "buildCommand",
  "nixpacksInstallCmd",
  "nixpacksBuildCmd",
  "nixpacksStartCmd",
  "outputDir",
  "composeFile",
  "composePath",
  "healthCmd",
  "memoryMb",
  "cpus",
  "gpus",
  "memorySwapMb",
  "pidsLimit",
  "shmSizeMb",
  "cpuShares",
  "cpusetCpus",
  "replicas",
  "hostPort",
  "containerPort",
  "domain",
  "domainRedirect",
  "securityHeaders",
  "gzip",
  "gitSubmodules",
  "gitLfs",
  "gitShallowClone",
  "disableBuildCache",
  "injectEnvAsBuildArgs",
  "sourceCommitMode",
  "restartPolicy",
  "restartMaxRetries",
  "stopGracePeriodSec",
  "drainSec",
  "containerAlias",
] as const;

/** Defaults of the git/build toggles: a snapshot taken before they existed (undefined) must not diff as a change
 *  against a new default-valued one. Non-GIT snapshots have both sides undefined, which normalise equal. */
const SNAPSHOT_DEFAULTS: Record<string, unknown> = {
  gitSubmodules: false,
  gitLfs: false,
  gitShallowClone: true,
  disableBuildCache: false,
  injectEnvAsBuildArgs: false,
  sourceCommitMode: "RUNTIME",
};

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Build a redacted snapshot from the (already env-resolved) deploy spec. */
export function buildConfigSnapshot(spec: AppSpec): ConfigSnapshot {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = fingerprint(v);
  const envFlags: Record<string, string> = {};
  const buildEnv: Record<string, string> = {};
  for (const k of Object.keys(spec.envMeta ?? {}).sort()) {
    const f = spec.envMeta![k];
    const token = flagsToken(f);
    if (token) envFlags[k] = token;
    if (f.buildTime && spec.buildArgs && Object.prototype.hasOwnProperty.call(spec.buildArgs, k)) buildEnv[k] = fingerprint(spec.buildArgs[k]);
  }
  return {
    snapV: 2,
    source: spec.source,
    image: spec.image ?? null,
    gitUrl: spec.gitUrl ?? null,
    gitBranch: spec.gitBranch ?? null,
    gitSubmodules: spec.gitSubmodules,
    gitLfs: spec.gitLfs,
    gitShallowClone: spec.gitShallowClone,
    disableBuildCache: spec.disableBuildCache,
    injectEnvAsBuildArgs: spec.injectEnvAsBuildArgs,
    sourceCommitMode: spec.sourceCommitMode,
    buildType: spec.buildType,
    dockerfilePath: spec.dockerfilePath ?? null,
    baseDirectory: spec.baseDirectory ?? null,
    buildCommand: spec.buildCommand ?? null,
    nixpacksInstallCmd: spec.nixpacksInstallCmd ?? null,
    nixpacksBuildCmd: spec.nixpacksBuildCmd ?? null,
    nixpacksStartCmd: spec.nixpacksStartCmd ?? null,
    outputDir: spec.outputDir ?? null,
    composeFile: spec.composeFile ?? null,
    composePath: spec.composePath ?? null,
    healthCmd: spec.healthCmd ?? null,
    memoryMb: spec.memoryMb ?? null,
    cpus: spec.cpus ?? null,
    gpus: spec.gpus ?? null,
    ...(spec.memorySwapMb != null ? { memorySwapMb: spec.memorySwapMb } : {}),
    ...(spec.pidsLimit != null ? { pidsLimit: spec.pidsLimit } : {}),
    ...(spec.shmSizeMb != null ? { shmSizeMb: spec.shmSizeMb } : {}),
    ...(spec.cpuShares != null ? { cpuShares: spec.cpuShares } : {}),
    ...(spec.cpusetCpus ? { cpusetCpus: spec.cpusetCpus } : {}),
    replicas: spec.replicas ?? null,
    hostPort: spec.hostPort ?? null,
    containerPort: spec.containerPort ?? null,
    domain: spec.domain ?? null,
    domainRedirect: spec.domainRedirect ?? null,
    securityHeaders: spec.securityHeaders,
    gzip: spec.gzip,
    ...(spec.restartPolicy ? { restartPolicy: spec.restartPolicy } : {}),
    ...(spec.restartMaxRetries ? { restartMaxRetries: spec.restartMaxRetries } : {}),
    ...(spec.stopGracePeriodSec ? { stopGracePeriodSec: spec.stopGracePeriodSec } : {}),
    ...(spec.drainSec ? { drainSec: spec.drainSec } : {}),
    ...(spec.containerAlias ? { containerAlias: spec.containerAlias } : {}),
    ...(spec.networks && spec.networks.length ? { networks: [...spec.networks].sort() } : {}),
    ...(spec.extraDomains && spec.extraDomains.length ? { extraDomains: [...spec.extraDomains].sort() } : {}),
    ...(spec.serviceDomains && spec.serviceDomains.length
      ? { serviceDomains: spec.serviceDomains.map((d) => ({ service: d.service, hostname: d.hostname, port: d.port })) }
      : {}),
    volumes: (spec.volumes ?? []).map((v) => ({ name: v.name, path: v.path })),
    ...(spec.configMounts && spec.configMounts.length
      ? { configMounts: spec.configMounts.map((m) => ({ target: m.target, mode: m.mode, fp: fingerprint(m.content) })) }
      : {}),
    env,
    ...(Object.keys(envFlags).length ? { envFlags } : {}),
    ...(Object.keys(buildEnv).length ? { buildEnv } : {}),
    hasGitToken: !!spec.gitToken,
    hasRegistryAuth: !!spec.registryAuth,
  };
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return String(v);
}

/**
 * Diff two snapshots into a flat list of changes. `prev === null` (first deploy
 * or a pre-snapshot row) yields no changes. env value changes are reported
 * without revealing the value.
 */
export function diffSnapshots(
  prev: ConfigSnapshot | null,
  next: ConfigSnapshot,
): ConfigChange[] {
  if (!prev) return [];
  const changes: ConfigChange[] = [];

  for (const f of SCALAR_FIELDS) {
    // An old snapshot (no snapV) never recorded restartPolicy, so its absence is not 'unset' - skip rather than
    // report a false before:'—' diff against every newer snapshot.
    if (f === "restartPolicy" && prev.snapV === undefined) continue;
    const a = (prev as unknown as Record<string, unknown>)[f] ?? SNAPSHOT_DEFAULTS[f];
    const b = (next as unknown as Record<string, unknown>)[f] ?? SNAPSHOT_DEFAULTS[f];
    if (show(a) !== show(b)) {
      changes.push({ field: f, kind: "changed", before: show(a), after: show(b) });
    }
  }

  // volumes: compare by name→path
  const pv = new Map((prev.volumes ?? []).map((v) => [v.name, v.path]));
  const nv = new Map((next.volumes ?? []).map((v) => [v.name, v.path]));
  for (const [name, path] of nv) {
    if (!pv.has(name)) changes.push({ field: `volume.${name}`, kind: "added", after: path });
    else if (pv.get(name) !== path)
      changes.push({ field: `volume.${name}`, kind: "changed", before: pv.get(name), after: path });
  }
  for (const [name] of pv) {
    if (!nv.has(name)) changes.push({ field: `volume.${name}`, kind: "removed" });
  }

  // extra domains: a hostname set (added/removed aliases).
  const pd = new Set(prev.extraDomains ?? []);
  const nd = new Set(next.extraDomains ?? []);
  for (const h of nd) if (!pd.has(h)) changes.push({ field: `extraDomain.${h}`, kind: "added", after: h });
  for (const h of pd) if (!nd.has(h)) changes.push({ field: `extraDomain.${h}`, kind: "removed", before: h });

  // extra networks: a name set (added/removed).
  const pn = new Set(prev.networks ?? []);
  const nn = new Set(next.networks ?? []);
  for (const n of nn) if (!pn.has(n)) changes.push({ field: `network.${n}`, kind: "added", after: n });
  for (const n of pn) if (!nn.has(n)) changes.push({ field: `network.${n}`, kind: "removed", before: n });

  // per-service domains: compare by hostname → "service:port".
  const psd = new Map((prev.serviceDomains ?? []).map((d) => [d.hostname, `${d.service}:${d.port}`]));
  const nsd = new Map((next.serviceDomains ?? []).map((d) => [d.hostname, `${d.service}:${d.port}`]));
  for (const [host, v] of nsd) {
    if (!psd.has(host)) changes.push({ field: `serviceDomain.${host}`, kind: "added", after: v });
    else if (psd.get(host) !== v) changes.push({ field: `serviceDomain.${host}`, kind: "changed", before: psd.get(host), after: v });
  }
  for (const [host, v] of psd) {
    if (!nsd.has(host)) changes.push({ field: `serviceDomain.${host}`, kind: "removed", before: v });
  }

  // config mounts: compare by target → content fingerprint (+ mode); content is never revealed.
  const pm = new Map((prev.configMounts ?? []).map((m) => [m.target, m]));
  const nm = new Map((next.configMounts ?? []).map((m) => [m.target, m]));
  for (const [target, m] of nm) {
    const p = pm.get(target);
    if (!p) changes.push({ field: `configMount.${target}`, kind: "added" });
    else if (p.fp !== m.fp || p.mode !== m.mode)
      changes.push({ field: `configMount.${target}`, kind: "changed" });
  }
  for (const [target] of pm) {
    if (!nm.has(target)) changes.push({ field: `configMount.${target}`, kind: "removed" });
  }

  // env: presence + fingerprint changes, never revealing values
  const pe = prev.env ?? {};
  const ne = next.env ?? {};
  for (const k of Object.keys(ne)) {
    if (!(k in pe)) changes.push({ field: `env.${k}`, kind: "added", after: SECRET });
    else if (pe[k] !== ne[k])
      changes.push({ field: `env.${k}`, kind: "changed", before: SECRET, after: SECRET });
  }
  for (const k of Object.keys(pe)) {
    if (!(k in ne)) changes.push({ field: `env.${k}`, kind: "removed", before: SECRET });
  }

  // env flags: readable tokens (flags are not secrets), so a flag-only edit shows up. A snapshot from before the
  // feature has no field, which reads as {} - no spurious diff.
  const pf = prev.envFlags ?? {};
  const nf = next.envFlags ?? {};
  for (const k of Object.keys(nf)) {
    if (!(k in pf)) changes.push({ field: `envFlags.${k}`, kind: "added", after: nf[k] });
    else if (pf[k] !== nf[k]) changes.push({ field: `envFlags.${k}`, kind: "changed", before: pf[k], after: nf[k] });
  }
  for (const k of Object.keys(pf)) if (!(k in nf)) changes.push({ field: `envFlags.${k}`, kind: "removed", before: pf[k] });

  // build-time variables: fingerprint changes, value never revealed (SECRET placeholder like env)
  const pb = prev.buildEnv ?? {};
  const nb = next.buildEnv ?? {};
  for (const k of Object.keys(nb)) {
    if (!(k in pb)) changes.push({ field: `buildEnv.${k}`, kind: "added", after: SECRET });
    else if (pb[k] !== nb[k]) changes.push({ field: `buildEnv.${k}`, kind: "changed", before: SECRET, after: SECRET });
  }
  for (const k of Object.keys(pb)) if (!(k in nb)) changes.push({ field: `buildEnv.${k}`, kind: "removed", before: SECRET });

  // credential presence
  if (prev.hasGitToken !== next.hasGitToken)
    changes.push({ field: "gitToken", kind: next.hasGitToken ? "added" : "removed" });
  if (prev.hasRegistryAuth !== next.hasRegistryAuth)
    changes.push({ field: "registryAuth", kind: next.hasRegistryAuth ? "added" : "removed" });

  return changes;
}
