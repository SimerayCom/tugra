import { createHash } from "node:crypto";
import type { AppSpec } from "./deploy-script";

/**
 * A redacted, persistable snapshot of the config a deploy ran with — so the
 * Deployments view can show "what changed since the last deploy". SECRETS NEVER
 * ENTER THE SNAPSHOT: env values become short fingerprints (sha256 prefix) used
 * only for change detection, and git/registry credentials collapse to booleans.
 */
export interface ConfigSnapshot {
  source?: string;
  image?: string | null;
  gitUrl?: string | null;
  gitBranch?: string | null;
  buildType?: string;
  dockerfilePath?: string | null;
  baseDirectory?: string | null;
  buildCommand?: string | null;
  outputDir?: string | null;
  composeFile?: string | null;
  composePath?: string | null;
  healthCmd?: string | null;
  memoryMb?: number | null;
  cpus?: number | null;
  gpus?: string | null;
  replicas?: number | null;
  hostPort?: number | null;
  containerPort?: number | null;
  domain?: string | null;
  domainRedirect?: "www" | "root" | null;
  securityHeaders?: boolean;
  /** Extra alias hostnames routed to the primary service (sorted; diffed as a set). */
  extraDomains?: string[];
  /** Per-service compose domains: hostname → the service + port it routes to (diffed by hostname). */
  serviceDomains?: { service: string; hostname: string; port: number }[];
  volumes: { name: string; path: string }[];
  /** config mount target → 12-hex fingerprint of its (placeholder) content — never stored verbatim. */
  configMounts?: { target: string; mode?: string; fp: string }[];
  /** env var name → 12-hex fingerprint of its value (value itself is never stored). */
  env: Record<string, string>;
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
  "outputDir",
  "composeFile",
  "composePath",
  "healthCmd",
  "memoryMb",
  "cpus",
  "gpus",
  "replicas",
  "hostPort",
  "containerPort",
  "domain",
  "domainRedirect",
  "securityHeaders",
] as const;

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Build a redacted snapshot from the (already env-resolved) deploy spec. */
export function buildConfigSnapshot(spec: AppSpec): ConfigSnapshot {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = fingerprint(v);
  return {
    source: spec.source,
    image: spec.image ?? null,
    gitUrl: spec.gitUrl ?? null,
    gitBranch: spec.gitBranch ?? null,
    buildType: spec.buildType,
    dockerfilePath: spec.dockerfilePath ?? null,
    baseDirectory: spec.baseDirectory ?? null,
    buildCommand: spec.buildCommand ?? null,
    outputDir: spec.outputDir ?? null,
    composeFile: spec.composeFile ?? null,
    composePath: spec.composePath ?? null,
    healthCmd: spec.healthCmd ?? null,
    memoryMb: spec.memoryMb ?? null,
    cpus: spec.cpus ?? null,
    gpus: spec.gpus ?? null,
    replicas: spec.replicas ?? null,
    hostPort: spec.hostPort ?? null,
    containerPort: spec.containerPort ?? null,
    domain: spec.domain ?? null,
    domainRedirect: spec.domainRedirect ?? null,
    securityHeaders: spec.securityHeaders,
    ...(spec.extraDomains && spec.extraDomains.length ? { extraDomains: [...spec.extraDomains].sort() } : {}),
    ...(spec.serviceDomains && spec.serviceDomains.length
      ? { serviceDomains: spec.serviceDomains.map((d) => ({ service: d.service, hostname: d.hostname, port: d.port })) }
      : {}),
    volumes: (spec.volumes ?? []).map((v) => ({ name: v.name, path: v.path })),
    ...(spec.configMounts && spec.configMounts.length
      ? { configMounts: spec.configMounts.map((m) => ({ target: m.target, mode: m.mode, fp: fingerprint(m.content) })) }
      : {}),
    env,
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
    const a = (prev as unknown as Record<string, unknown>)[f];
    const b = (next as unknown as Record<string, unknown>)[f];
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

  // credential presence
  if (prev.hasGitToken !== next.hasGitToken)
    changes.push({ field: "gitToken", kind: next.hasGitToken ? "added" : "removed" });
  if (prev.hasRegistryAuth !== next.hasRegistryAuth)
    changes.push({ field: "registryAuth", kind: next.hasRegistryAuth ? "added" : "removed" });

  return changes;
}
