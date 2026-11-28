import { parse, stringify } from "yaml";
import { assertSafeCompose, isSensitivePath } from "../deploy/compose-safety";
import { validateConfigMountTarget } from "../templates/template-manifest";
import type { ForeignService } from "./foreign-fleet";
import type { ServiceChoice } from "./dto";
import { VOLUME_NAME_RE } from "./migration-volume";
import { isDigestPinned, isExactPinFor } from "./exact-image";

/**
 * Pure transform of one Coolify SERVICE's RAW compose (`docker_compose_raw`) into the compose a stopped Tugra COMPOSE app
 * stores. One engine, no schema: the source's own compose is rewritten, never regenerated from a template (a template
 * would mint fresh secrets and a magic domain; the source's real secrets and data must carry over unchanged).
 *
 * No I/O, no secrets in anything it reports. Every string in `dropped` / `volumes` / `gate` is a FIXED reason plus a
 * compose service key or variable NAME, never a value. Hostile input is expected (the compose text comes from another
 * PaaS): size cap, alias cap, structural validation, and the same safety gate `apps.create` re-runs have the last word.
 */

export const MAX_SERVICE_COMPOSE_BYTES = 256 * 1024;
/** A config file bigger than this is treated as not available (the whole app's scripts must stay within the agent's argv). */
export const MAX_CONFIG_FILE_BYTES = 64 * 1024;
export const MAX_CONFIG_MOUNTS = 16;

const SVC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAMED_VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAGIC_URL_RE = /^SERVICE_(URL|FQDN)_([A-Za-z0-9_]+)$/;
/** Magic secrets keep their EXACT names; their values come ONLY from the source bundle (never regenerated). */
const MAGIC_SECRET_RE = /^SERVICE_(PASSWORD|USER|BASE64|REALBASE64)_/;
const SECRET_KEY_RE = /PASSWORD|SECRET|TOKEN|KEY/i;
const IMAGE_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,200}$/;
const PIN_REF_RE = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,100}:[0-9]{1,5}\/)?[A-Za-z0-9][A-Za-z0-9._/-]{0,200}(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

/** A MinIO object-store service: by its one-click template slug, or by a MinIO image in its compose file. */
export function isMinioService(s: { templateSlug?: string; composeFile?: string }): boolean {
  return s.templateSlug === "minio" || /minio\/minio/.test(s.composeFile ?? "");
}

export type ServiceVerdict = "importable" | "partial" | "skipped";
export type ServiceDataPlane = "hub-staged" | "manual-large" | "not-carried" | "config-file" | "stateless";

export interface ServiceVolume {
  key: string;
  origin: "named" | "host-bind";
  /** The ABSOLUTE source path of a host bind (never mounted on the target; shown so the operator can find the data). */
  sourcePath?: string;
  mounts: Array<{ service: string; path: string }>;
  policy: "copy" | "empty" | "skip";
  dataPlane: ServiceDataPlane;
}

export interface ServiceTransformInput {
  svc: ForeignService;
  raw: string; // docker_compose_raw
  /** Apply/preview time only. `undefined` = plan time (no secrets known): nothing is reported missing. */
  bundle?: { values: ReadonlyMap<string, string> | Record<string, string>; files?: Array<{ path: string; content: string; mode?: string }> };
  choice?: ServiceChoice;
  /** service compose key -> image reference, from the source probe or the operator. */
  pins?: Record<string, string>;
}

export interface ServiceDomainRow {
  service: string;
  hostname: string;
  port: number;
}

export interface ServiceTransformResult {
  compose: string;
  /** Values for the app env: the carried bundle values of the keys the compose references, plus hoisted literal secrets. Null-prototype. */
  env: Record<string, string>;
  configMounts: Array<{ serviceName: string; target: string; content: string; mode?: string }>;
  volumes: ServiceVolume[];
  /** What was not carried as-is. Field names + FIXED reasons only (a field is `<service>.<key>` or `volume:<key>`). */
  dropped: Array<{ field: string; reason: string; level: "warn" | "info" }>;
  /** Apply time only: referenced keys with no value in the bundle (names). */
  missingEnv: string[];
  /** Plan time only (no bundle): keys the compose references that need a source value (names). */
  unverifiedKeys: string[];
  /** Relative bind sources whose content is not available in the bundle. */
  neededFiles: string[];
  gate: "ok" | { code: string; detail: string };
  verdict: ServiceVerdict;
  membersKept: string[];
  membersDropped: Array<{ name: string; reason: string }>;
  /** Effective routing rows (member fqdns after hostnameMap, or the operator's rows), for KEPT members only. */
  domains: ServiceDomainRow[];
  /** `SERVICE_URL_*_<port>` bare entries that were turned into hints (service, port) for the preview editor. */
  domainHints: Array<{ service: string; port: number }>;
  /** Services still on a floating tag (`:latest` / untagged) after pinning. */
  floating: string[];
  /** The image each floating service is written with in the source's compose (what a pin has to replace), by service key. */
  floatingRefs: Record<string, string>;
  /**
   * The image every KEPT member that is not on a digest is written with in the source's compose, by service key: what an exact-image pin
   * (`repo:tag@sha256:...`) replaces. Floating and moving tags alike. Additive, outside the plan hash.
   */
  images: Record<string, string>;
  pinned: string[];
  hold: boolean;
}

export interface Tok {
  t: "lit" | "ref";
  text?: string;
  raw?: string;
  name?: string;
  op?: string;
  arg?: string;
}

/** Tokenise a compose string value into literals and variable references. `$$` is an escape and stays a literal. */
export function tokenizeVars(s: string): Tok[] {
  const out: Tok[] = [];
  let lit = "";
  const flush = () => {
    if (lit) {
      out.push({ t: "lit", text: lit });
      lit = "";
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "$") {
      if (s[i + 1] === "$") {
        lit += "$$";
        i += 2;
        continue;
      }
      if (s[i + 1] === "{") {
        let depth = 1;
        let j = i + 2;
        while (j < s.length && depth > 0) {
          if (s[j] === "{" && s[j - 1] === "$") depth++;
          else if (s[j] === "}") depth--;
          j++;
        }
        if (depth === 0) {
          const inner = s.slice(i + 2, j - 1);
          const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/.exec(inner);
          if (m) {
            flush();
            out.push({ t: "ref", raw: s.slice(i, j), name: m[1], op: m[2], arg: m[3] });
          } else {
            lit += s.slice(i, j);
          }
          i = j;
          continue;
        }
      } else {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i + 1));
        if (m) {
          flush();
          out.push({ t: "ref", raw: `$${m[0]}`, name: m[0] });
          i += 1 + m[0].length;
          continue;
        }
      }
    }
    lit += c;
    i++;
  }
  flush();
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const sortBy = <T>(xs: T[], key: (x: T) => string): T[] => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** A failed gate. `detail` is a fixed directive name or a compose service key, never a value. */
const fail = (code: string, detail = ""): { code: string; detail: string } => ({ code, detail });

function emptyResult(over: Partial<ServiceTransformResult>): ServiceTransformResult {
  return {
    compose: "",
    env: Object.create(null),
    configMounts: [],
    volumes: [],
    dropped: [],
    missingEnv: [],
    unverifiedKeys: [],
    neededFiles: [],
    gate: "ok",
    verdict: "skipped",
    membersKept: [],
    membersDropped: [],
    domains: [],
    domainHints: [],
    floating: [],
    floatingRefs: {},
    images: {},
    pinned: [],
    hold: false,
    ...over,
  };
}

/** The gate's directive text, trimmed to the directive NAME (the Nest message may echo a path or a service key). */
function directiveOf(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  const d = m.includes("directive:") ? m.split("directive:")[1].trim() : m;
  return d.replace(/\s*\(.*$/, "").replace(/["'].*$/, "").trim().slice(0, 60) || "disallowed";
}

/** Structural rejections a member can be DROPPED for (the rest fail the whole service closed). */
const DROP_CLASSES: Array<[RegExp, string]> = [
  [/^docker socket bind/, "docker-socket"],
  [/^privileged/, "privileged"],
  [/^(network_mode|pid|ipc|userns_mode|uts|cgroup)\b/, "host-namespace"],
  [/^(devices|device_cgroup_rules)/, "devices"],
  [/^cap_add/, "capability"],
  [/^security_opt/, "security-opt"],
];
const DROP_REASON: Record<string, string> = {
  "docker-socket": "needs the Docker socket (never carried)",
  privileged: "needs privileged mode (never carried)",
  "host-namespace": "needs a host or shared namespace (never carried)",
  devices: "needs host devices (never carried)",
  capability: "needs a capability Tugra does not allow",
  "security-opt": "disables container confinement (never carried)",
  requested: "excluded by the operator",
};

/** Per-service volume defaults by one-click template: telemetry is not carried, coordination state starts empty. */
const VOLUME_DEFAULTS: Record<string, Record<string, "skip" | "empty">> = {
  signoz: { clickhouse: "skip", zookeeper: "empty" },
};

/** `name:tag` / digest check: true when the image has no tag, or the tag is `latest`, and no digest pins it. */
function isFloating(image: string): boolean {
  if (/@sha256:[a-f0-9]{64}$/.test(image)) return false;
  const last = image.split("/").pop() ?? image;
  const colon = last.indexOf(":");
  if (colon < 0) return true;
  return last.slice(colon + 1) === "latest";
}
/** True when `candidate` is a version the transform would accept as the pin of the floating `image` (same repository, not floating, a valid ref). */
export const isPinFor = (image: string, candidate: string): boolean => PIN_REF_RE.test(candidate) && IMAGE_REPO_RE.test(image) && imageRepo(candidate) === imageRepo(image) && !isFloating(candidate);
const imageRepo = (image: string): string => {
  const noDigest = image.split("@")[0];
  const last = noDigest.split("/").pop() ?? noDigest;
  const colon = last.indexOf(":");
  return colon < 0 ? noDigest : noDigest.slice(0, noDigest.length - (last.length - colon));
};

function lookup(bundle: ServiceTransformInput["bundle"], key: string): string | undefined {
  if (!bundle) return undefined;
  const v = bundle.values;
  if (v instanceof Map) return v.get(key);
  return Object.prototype.hasOwnProperty.call(v, key) ? (v as Record<string, string>)[key] : undefined;
}

/** Sanitise `<service>-<basename(target)>` into a VOLUME_NAME_RE-safe key (lowercase, <= 41 chars). */
function hostBindKey(service: string, target: string): string {
  const base = target.split("/").filter(Boolean).pop() ?? "data";
  const raw = `${service}-${base}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "");
  return (raw || "service-data").slice(0, 41).replace(/-+$/, "") || "data";
}

function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const cand = `${base.slice(0, 41 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(cand)) return cand;
  }
  return base; // unreachable in practice; the VOLUME_NAME_RE gate downstream still holds
}

/** Normalised repo-relative bind source, or null when it must be refused (`..`, `.env`, the mounts dir, compose files). */
function relBindSource(src: string): string | null {
  const s = src.replace(/^(\.\/)+/, "");
  if (s === "" || s === "." || s.startsWith("/") || s.startsWith("~")) return null;
  const parts = s.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  const first = parts[0];
  if (first === ".env" || first === "mounts" || /^docker-compose.*\.ya?ml$/.test(first)) return null;
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(parts.join("/"))) return null;
  return parts.join("/");
}

interface ParsedVolume {
  kind: "named" | "abs" | "rel" | "other";
  source: string;
  target: string;
  mode?: string; // short syntax trailing flags
  readOnly?: boolean;
  long: boolean;
}

function parseVolumeEntry(v: unknown): ParsedVolume | null {
  if (typeof v === "string") {
    if (!v.includes(":")) return null; // anonymous volume: Docker manages it, nothing to carry
    const parts = v.split(":");
    const source = parts[0];
    const target = parts[1] ?? "";
    const mode = parts.length > 2 ? parts.slice(2).join(":") : undefined;
    return { ...classify(source), source, target, mode, readOnly: mode ? mode.split(",").includes("ro") : false, long: false };
  }
  if (isObj(v)) {
    const type = v.type;
    const source = typeof v.source === "string" ? v.source : "";
    const target = typeof v.target === "string" ? v.target : "";
    if (!target) return null;
    if (type === "volume" || (type === undefined && source && NAMED_VOLUME_RE.test(source))) {
      if (!source) return null; // anonymous
      return { kind: source.includes("$") ? "other" : NAMED_VOLUME_RE.test(source) ? "named" : "other", source, target, readOnly: v.read_only === true, long: true };
    }
    if (type === "bind") return { ...classify(source), source, target, readOnly: v.read_only === true, long: true };
    return { kind: "other", source, target, long: true };
  }
  return null;
}

function classify(source: string): { kind: ParsedVolume["kind"] } {
  if (source === "" || source.includes("$")) return { kind: "other" };
  if (source.startsWith("/")) return { kind: "abs" };
  if (source.startsWith(".") || source.startsWith("~")) return { kind: "rel" };
  if (NAMED_VOLUME_RE.test(source)) return { kind: "named" };
  return { kind: "other" };
}

/**
 * The transform. Total (never throws), deterministic, and idempotent on its own output. Rule ids (R1..R11) follow the
 * G4-C spec; the order here is: parse (R1) → per-service cleanups (R2/R5/R6/R7) → member drops (R9) → variables, volumes
 * and config binds on the survivors (R3/R4/R8) → image pins (R10) → the safety gate (R11).
 */
export function transformServiceCompose(input: ServiceTransformInput): ServiceTransformResult {
  const { svc, raw, bundle, choice } = input;
  const hold = choice?.hold ?? svc.templateSlug === "cloudflared";

  // R1 — parse and shape.
  if (typeof raw !== "string" || raw.trim() === "") return emptyResult({ gate: fail("compose-unparsed"), hold });
  if (Buffer.byteLength(raw, "utf8") > MAX_SERVICE_COMPOSE_BYTES) return emptyResult({ gate: fail("compose-too-large"), hold });
  let doc: unknown;
  try {
    doc = parse(raw, { merge: true, maxAliasCount: 50 });
  } catch {
    return emptyResult({ gate: fail("compose-unparsed"), hold });
  }
  if (!isObj(doc) || !isObj(doc.services) || Object.keys(doc.services).length === 0) return emptyResult({ gate: fail("compose-unparsed"), hold });
  const servicesIn = doc.services as Record<string, unknown>;
  for (const [name, def] of Object.entries(servicesIn)) {
    if (!SVC_NAME_RE.test(name)) return emptyResult({ gate: fail("service-name"), hold });
    if (!isObj(def)) return emptyResult({ gate: fail("compose-unparsed"), hold });
  }

  const dropped: ServiceTransformResult["dropped"] = [];
  const note = (field: string, reason: string, level: "warn" | "info" = "info") => {
    if (!dropped.some((d) => d.field === field && d.reason === reason)) dropped.push({ field, reason, level });
  };

  const services: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [name, def] of Object.entries(servicesIn)) services[name] = structuredClone(def) as Record<string, unknown>;

  // R2 / R5 / R6 / R7 — per-service cleanups.
  for (const [name, def] of Object.entries(services)) {
    if ("exclude_from_hc" in def) {
      delete def.exclude_from_hc;
      note(`${name}.exclude_from_hc`, "Coolify-only key; Tugra has no equivalent");
    }
    if ("container_name" in def) {
      delete def.container_name;
      note(`${name}.container_name`, "container names are not carried; the service key is the DNS name on the app network", "warn");
    }
    if (def.labels !== undefined) stripLabels(name, def, "labels", note);
    if (isObj(def.deploy) && def.deploy.labels !== undefined) stripLabels(name, def.deploy, "deploy.labels", note);
    if ("ports" in def) {
      delete def.ports;
      note(`${name}.ports`, "published ports are not carried; use service domains", "warn");
    }
  }

  // R9 — members the gate rejects structurally (and the operator's extra exclusions) are dropped, deterministically.
  const droppedMembers = new Map<string, string>();
  for (const name of Object.keys(services).sort()) {
    try {
      assertSafeCompose(stringify({ services: { [name]: services[name] } }));
    } catch (e) {
      const dir = directiveOf(e);
      const cls = DROP_CLASSES.find(([re]) => re.test(dir));
      if (cls) droppedMembers.set(name, cls[1]);
    }
  }
  for (const n of choice?.dropMembers ?? []) if (services[n] && !droppedMembers.has(n)) droppedMembers.set(n, "requested");
  for (const [name, cls] of droppedMembers) {
    delete services[name];
    note(`member:${name}`, DROP_REASON[cls] ?? "not carried", "warn");
  }
  const survivorNames = Object.keys(services);
  if (survivorNames.length === 0) {
    return emptyResult({
      dropped: sortBy(dropped, (d) => d.field),
      membersDropped: sortBy([...droppedMembers].map(([name, c]) => ({ name, reason: DROP_REASON[c] ?? "not carried" })), (m) => m.name),
      hold,
    });
  }
  for (const [name, def] of Object.entries(services)) {
    const dep = def.depends_on;
    if (Array.isArray(dep)) {
      const kept = dep.filter((d) => !(typeof d === "string" && droppedMembers.has(d)));
      if (kept.length !== dep.length) def.depends_on = kept;
    } else if (isObj(dep)) {
      for (const d of Object.keys(dep)) {
        if (!droppedMembers.has(d)) continue;
        const cond = isObj(dep[d]) ? (dep[d] as Record<string, unknown>).condition : undefined;
        if (cond !== undefined && cond !== "service_started") {
          return emptyResult({ gate: fail("member-required", name), dropped: sortBy(dropped, (x) => x.field), hold });
        }
        delete dep[d];
      }
    }
    if ((Array.isArray(def.depends_on) || isObj(def.depends_on)) && Object.keys(def.depends_on as object).length === 0) delete def.depends_on;
  }

  // R3 pass 1 — environment: drop magic URL entries (they become routing hints) and hoist literal secrets.
  const env: Record<string, string> = Object.create(null);
  const domainHints: Array<{ service: string; port: number }> = [];
  const hoistConflicts = new Set<string>();
  for (const name of survivorNames) processEnvironment(name, services[name], env, domainHints, hoistConflicts, note);

  // Effective routing rows for KEPT members (after hostnameMap, or the operator's own rows).
  const domains = effectiveDomains(svc, new Set(survivorNames), domainHints, choice);

  // R3 pass 2 + R4 — resolve `${SERVICE_URL_*}` references, classify every other variable.
  const refs = new Map<string, { needsValue: boolean }>();
  const magicLeft = new Set<string>();
  const rewriteStr = (s: string): string => {
    const toks = tokenizeVars(s);
    if (!toks.some((t) => t.t === "ref")) return s;
    let out = "";
    for (const t of toks) {
      if (t.t === "lit") {
        out += t.text;
        continue;
      }
      const name = t.name!;
      const m = MAGIC_URL_RE.exec(name);
      if (m) {
        const row = magicRow(domains, m[2]);
        if (row) out += m[1] === "URL" ? `https://${row.hostname}` : row.hostname;
        else {
          out += t.raw;
          magicLeft.add(name);
        }
        continue;
      }
      out += t.raw;
      collectRef(t, refs);
    }
    return out;
  };
  for (const name of survivorNames) services[name] = mapStrings(services[name], rewriteStr) as Record<string, unknown>;
  for (const n of [...magicLeft].sort()) note(n, "magic URL variable is not resolved (no domain is mapped for it); set the value by hand", "warn");

  // R8 — volumes, host binds and relative file binds.
  const volOut = processVolumes(services, doc.volumes, svc, bundle, choice, note);
  if ("fail" in volOut) return emptyResult({ gate: volOut.fail, dropped: sortBy(dropped, (x) => x.field), hold });

  // R10 — exact images. A member that is not on a digest takes the exact-image pin it is given (the digest-pinned ref the source runs, or
  // the operator's own version), unless the stack opted out (`pinImages: false`). A floating member left without a pin is reported.
  const floating: string[] = [];
  const floatingRefs: Record<string, string> = {};
  const images: Record<string, string> = {};
  const pinned: string[] = [];
  for (const name of survivorNames) {
    const def = services[name];
    if (typeof def.image !== "string" || isDigestPinned(def.image)) continue;
    images[name] = def.image;
    const pin = input.pins?.[name] ?? choice?.pins?.[name];
    if (pin && choice?.pinImages !== false && PIN_REF_RE.test(pin) && IMAGE_REPO_RE.test(def.image) && isExactPinFor(def.image, pin)) {
      def.image = pin;
      pinned.push(name);
      note(`${name}.image`, "pinned to the image the source is running", "info");
    } else if (isFloating(def.image)) {
      floating.push(name);
      floatingRefs[name] = def.image;
    }
  }

  // Assemble the output compose: survivors only, the declared volumes, everything else at the top level as given.
  const top: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (k !== "services" && k !== "volumes") top[k] = v;
  const out: Record<string, unknown> = { ...top, services };
  if (Object.keys(volOut.declared).length) out.volumes = volOut.declared;
  const compose = stringify(out, { lineWidth: 0 });

  // R11 — the final gate (also re-run by apps.create).
  let gate: ServiceTransformResult["gate"] = "ok";
  try {
    assertSafeCompose(compose);
  } catch (e) {
    gate = fail("compose-safety", directiveOf(e));
  }

  // R4 — carry only the referenced keys; the rest of the source's env rows are bookkeeping.
  const missing: string[] = [];
  const unverified: string[] = [];
  for (const [name, r] of [...refs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (name in env) continue; // a hoisted literal already owns the key
    const v = lookup(bundle, name);
    if (v !== undefined) env[name] = v;
    else if (r.needsValue) (bundle ? missing : unverified).push(name);
  }

  const neededFiles = volOut.neededFiles;
  const membersDropped = sortBy([...droppedMembers].map(([n, c]) => ({ name: n, reason: DROP_REASON[c] ?? "not carried" })), (m) => m.name);
  const volumes = volOut.volumes;
  let verdict: ServiceVerdict = "importable";
  if (gate !== "ok" || (bundle && neededFiles.length > 0)) verdict = "skipped";
  else if (membersDropped.length > 0 || volumes.some((v) => v.policy === "skip")) verdict = "partial";

  return {
    compose,
    env,
    configMounts: volOut.configMounts,
    volumes,
    dropped: sortBy(dropped, (d) => `${d.field}\u0000${d.reason}`),
    missingEnv: missing,
    unverifiedKeys: unverified,
    neededFiles,
    gate,
    verdict,
    membersKept: [...survivorNames].sort(),
    membersDropped,
    domains,
    domainHints: sortBy(domainHints, (h) => `${h.service}:${h.port}`),
    floating: floating.sort(),
    floatingRefs,
    images,
    pinned: pinned.sort(),
    hold,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Note = (field: string, reason: string, level?: "warn" | "info") => void;

function collectRef(t: Tok, refs: Map<string, { needsValue: boolean }>): void {
  const hasDefault = t.op === ":-" || t.op === "-" || t.op === ":+" || t.op === "+";
  const prev = refs.get(t.name!);
  refs.set(t.name!, { needsValue: (prev?.needsValue ?? false) || !hasDefault });
  if (t.arg) for (const a of tokenizeVars(t.arg)) if (a.t === "ref" && !MAGIC_URL_RE.test(a.name!)) collectRef(a, refs);
}

function mapStrings(node: unknown, fn: (s: string) => string): unknown {
  if (typeof node === "string") return fn(node);
  if (Array.isArray(node)) return node.map((n) => mapStrings(n, fn));
  if (isObj(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = mapStrings(v, fn);
    return out;
  }
  return node;
}

function labelKey(entry: unknown): string {
  return String(entry).split("=")[0].trim().toLowerCase();
}

function stripLabels(service: string, host: Record<string, unknown>, field: string, note: Note): void {
  const labels = host.labels;
  let coolify = 0;
  let traefik = 0;
  let accessControl = false;
  const isTraefik = (k: string) => k.startsWith("traefik.");
  const drop = (k: string): boolean => {
    if (k.startsWith("coolify.")) {
      coolify++;
      return true;
    }
    if (isTraefik(k)) {
      traefik++;
      if (/\.(basicauth|ipallowlist|ipwhitelist|forwardauth|digestauth)\b/.test(k)) accessControl = true;
      return true;
    }
    return false;
  };
  if (Array.isArray(labels)) {
    const kept = labels.filter((e) => !drop(labelKey(e)));
    if (kept.length) host.labels = kept;
    else delete host.labels;
  } else if (isObj(labels)) {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(labels)) if (!drop(k.trim().toLowerCase())) kept[k] = v;
    if (Object.keys(kept).length) host.labels = kept;
    else delete host.labels;
  }
  if (coolify) note(`${service}.${field}.coolify`, "Coolify bookkeeping labels are not carried");
  if (traefik) note(`${service}.${field}.traefik`, "Traefik routing labels are replaced by Tugra service domains", "warn");
  if (accessControl) note(`${service}.${field}.access-control`, "an access-control middleware (basic auth / allow-list) was among the Traefik labels; re-protect the service", "warn");
}

function processEnvironment(
  service: string,
  def: Record<string, unknown>,
  env: Record<string, string>,
  hints: Array<{ service: string; port: number }>,
  hoistConflicts: Set<string>,
  note: Note,
): void {
  const environment = def.environment;
  const handle = (key: string, value: unknown): "keep" | "drop" | { rewrite: string } => {
    const m = MAGIC_URL_RE.exec(key);
    if (m) {
      const pm = /_(\d{1,5})$/.exec(m[2]);
      if (pm && Number(pm[1]) >= 1 && Number(pm[1]) <= 65535) hints.push({ service, port: Number(pm[1]) });
      return "drop";
    }
    if (typeof value === "string" && value !== "" && !value.includes("$") && SECRET_KEY_RE.test(key) && ENV_NAME_RE.test(key)) {
      // Literal-secret hoist: the secret moves to the app env, the compose keeps only a reference.
      let target = key;
      if (target in env && env[target] !== value) target = `${service.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${key}`;
      if (!ENV_NAME_RE.test(target) || (target in env && env[target] !== value)) {
        hoistConflicts.add(key);
        return "keep";
      }
      env[target] = value;
      note(`${service}.environment.${key}`, "a literal secret was moved to the app environment (the compose keeps a reference)", "info");
      return { rewrite: `\${${target}}` };
    }
    return "keep";
  };
  if (Array.isArray(environment)) {
    const out: unknown[] = [];
    for (const e of environment) {
      if (typeof e !== "string") {
        out.push(e);
        continue;
      }
      const eq = e.indexOf("=");
      const key = eq < 0 ? e : e.slice(0, eq);
      const value = eq < 0 ? undefined : e.slice(eq + 1);
      const r = handle(key, value);
      if (r === "drop") continue;
      out.push(typeof r === "object" ? `${key}=${r.rewrite}` : e);
    }
    if (out.length) def.environment = out;
    else delete def.environment;
  } else if (isObj(environment)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(environment)) {
      const r = handle(key, value);
      if (r === "drop") continue;
      out[key] = typeof r === "object" ? r.rewrite : value;
    }
    if (Object.keys(out).length) def.environment = out;
    else delete def.environment;
  }
}

/** The routing rows for the kept members. An operator-supplied list REPLACES the source rows entirely. */
function effectiveDomains(svc: ForeignService, kept: Set<string>, hints: Array<{ service: string; port: number }>, choice?: ServiceChoice): ServiceDomainRow[] {
  const rows: ServiceDomainRow[] = [];
  if (choice?.serviceDomains) {
    for (const r of choice.serviceDomains) if (kept.has(r.service)) rows.push({ service: r.service, hostname: r.hostname, port: r.port });
  } else {
    const map = choice?.hostnameMap ?? {};
    for (const m of svc.members ?? []) {
      if (!kept.has(m.name)) continue;
      for (const d of m.domains) {
        const hint = hints.filter((h) => h.service === m.name);
        const port = d.port ?? (hint.length === 1 ? hint[0].port : undefined);
        if (!port) continue;
        const host = d.host.toLowerCase();
        rows.push({ service: m.name, hostname: map[host] ?? host, port });
      }
    }
  }
  const seen = new Set<string>();
  return sortBy(rows, (r) => r.hostname).filter((r) => (seen.has(r.hostname) ? false : (seen.add(r.hostname), true)));
}

function magicRow(rows: ServiceDomainRow[], nameAndPort: string): ServiceDomainRow | undefined {
  const pm = /^(.*?)(?:_(\d{1,5}))?$/.exec(nameAndPort);
  const base = norm(pm?.[1] ?? nameAndPort);
  const port = pm?.[2] ? Number(pm[2]) : undefined;
  return rows.find((r) => norm(r.service) === base && (port === undefined || r.port === port));
}

interface VolOut {
  volumes: ServiceVolume[];
  declared: Record<string, unknown>;
  configMounts: ServiceTransformResult["configMounts"];
  neededFiles: string[];
}

function processVolumes(
  services: Record<string, Record<string, unknown>>,
  topVolumes: unknown,
  svc: ForeignService,
  bundle: ServiceTransformInput["bundle"],
  choice: ServiceChoice | undefined,
  note: Note,
): VolOut | { fail: { code: string; detail: string } } {
  const top = isObj(topVolumes) ? topVolumes : {};
  const used = new Map<string, ServiceVolume>(); // key -> volume
  const bindKeyBySource = new Map<string, string>();
  const taken = new Set<string>();
  const files = new Map<string, { content: string; mode?: string }>();
  for (const f of bundle?.files ?? []) files.set(f.path.replace(/^(\.\/)+/, ""), { content: f.content, mode: f.mode });
  const configMounts: ServiceTransformResult["configMounts"] = [];
  const neededFiles: string[] = [];

  const addMount = (key: string, origin: "named" | "host-bind", service: string, path: string, sourcePath?: string) => {
    const v = used.get(key) ?? { key, origin, ...(sourcePath ? { sourcePath } : {}), mounts: [], policy: "copy" as const, dataPlane: "hub-staged" as ServiceDataPlane };
    v.mounts.push({ service, path });
    used.set(key, v);
    taken.add(key);
  };

  // Named keys already in use come first so a host-bind rewrite never takes one.
  for (const def of Object.values(services)) {
    for (const entry of Array.isArray(def.volumes) ? def.volumes : []) {
      const p = parseVolumeEntry(entry);
      if (p?.kind === "named") taken.add(p.source);
    }
  }

  for (const name of Object.keys(services).sort()) {
    const def = services[name];
    if (!Array.isArray(def.volumes)) continue;
    const next: unknown[] = [];
    for (const entry of def.volumes) {
      const p = parseVolumeEntry(entry);
      if (!p || p.kind === "other") {
        next.push(entry);
        continue;
      }
      if (p.kind === "named") {
        if (!VOLUME_NAME_RE.test(p.source)) return { fail: fail("volume-name", p.source.slice(0, 64)) };
        addMount(p.source, "named", name, p.target);
        next.push(entry);
        continue;
      }
      if (p.kind === "abs") {
        // A bind of a sensitive host path (or the docker socket) is NEVER rewritten: the safety gate reports it.
        if (isSensitivePath(p.source) || /(^|\/)docker\.sock$/.test(p.source)) {
          next.push(entry);
          continue;
        }
        const existing = bindKeyBySource.get(p.source);
        const key = existing ?? uniqueKey(hostBindKey(name, p.target), taken);
        if (!existing) {
          bindKeyBySource.set(p.source, key);
          note(`volume:${key}`, "a host folder bind is carried as a named volume; the host path is not mounted on the target", "warn");
        }
        addMount(key, "host-bind", name, p.target, p.source);
        next.push(p.long ? { type: "volume", source: key, target: p.target, ...(p.readOnly ? { read_only: true } : {}) } : `${key}:${p.target}${p.mode ? `:${p.mode}` : ""}`);
        continue;
      }
      // Relative bind: a config FILE the source keeps next to its compose. Removed from the volumes, carried as a config mount.
      const rel = relBindSource(p.source);
      if (!rel) return { fail: fail("bind-path", name) };
      try {
        validateConfigMountTarget(p.target);
      } catch {
        return { fail: fail("mount-target", name) };
      }
      const f = files.get(rel);
      if (f && Buffer.byteLength(f.content, "utf8") <= MAX_CONFIG_FILE_BYTES) {
        configMounts.push({ serviceName: name, target: p.target, content: f.content, ...(f.mode ? { mode: f.mode } : {}) });
        if (/(password|secret|token|api[_-]?key)\s*[:=]/i.test(f.content)) {
          note(`configMount:${p.target}`, "this config file contains a secret-looking key; it is stored as plain text, like a template's config files", "warn");
        }
        note(`${name}.volumes`, "a config file bind was carried as a Tugra config mount", "info");
      } else if (!neededFiles.includes(rel)) {
        neededFiles.push(rel);
      }
    }
    if (next.length) def.volumes = next;
    else delete def.volumes;
  }
  if (configMounts.length > MAX_CONFIG_MOUNTS) return { fail: fail("config-mount-limit") };
  configMounts.sort((a, b) => (a.serviceName + a.target < b.serviceName + b.target ? -1 : 1));
  neededFiles.sort();

  // Declare every volume the survivors use (the raw compose never has a top-level block). A pre-declared external /
  // named volume is not carried: the key is declared plain and the data comes from the data step.
  const declared: Record<string, unknown> = {};
  const defaults = svc.templateSlug ? VOLUME_DEFAULTS[svc.templateSlug] : undefined;
  const volumes: ServiceVolume[] = [];
  for (const key of [...used.keys()].sort()) {
    const v = used.get(key)!;
    const existing = top[key];
    if (isObj(existing)) {
      const external = existing.external === true || isObj(existing.external);
      const named = typeof existing.name === "string" && existing.name !== "";
      if (external || named) {
        declared[key] = {};
        note(`volume:${key}`, "an external or explicitly named volume is declared as a plain one on the target", "warn");
      } else declared[key] = existing;
    } else declared[key] = {};
    const policy = choice?.volumes?.[key]?.policy ?? (defaults?.[key] ?? "copy");
    v.policy = policy;
    // An object store's volume is never streamed with the service (its buckets move through Object migration), whatever the policy says.
    v.dataPlane = policy === "copy" ? (isMinioService(svc) ? "not-carried" : "hub-staged") : policy === "empty" ? "stateless" : "not-carried";
    v.mounts.sort((a, b) => (a.service + a.path < b.service + b.path ? -1 : 1));
    volumes.push(v);
    if (policy === "skip") note(`volume:${key}`, "the data of this volume is not carried; Compose creates it empty on the first deploy", "warn");
  }
  return { volumes, declared, configMounts, neededFiles };
}
