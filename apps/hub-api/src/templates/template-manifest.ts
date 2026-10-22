import { posix } from "node:path";
import { BadRequestException } from "@nestjs/common";
import type { SecretKind, SecretSpec, TemplateDef, TemplateMeta } from "./catalog";

// A rich, install-time template model. Today's `TemplateDef` bakes host ports and localhost URLs at
// import time and offers no install configuration; the manifest is the shape that the App Store
// resolves at INSTALL time (typed user form, dynamic ports, real URLs, config mounts, signed
// remote catalog). It only adds the type model + a backward-compatible mapper — behaviour is
// unchanged, `createFromTemplate` still uses the old baked-compose path.

/** The kind of input a template field accepts (drives the web form widget + validation). */
export type FieldType =
  | "text"
  | "password"
  | "number"
  | "boolean"
  | "email"
  | "url"
  | "fqdn"
  | "port"
  | "select"
  | "random"
  | "hidden";

/** A user-facing, typed install field. A field with `generate` set is auto-filled server-side when
 *  the user leaves it blank, so it is never `required`. `secret: true` means the resolved value is
 *  never pre-filled back to the client. */
export interface FormField {
  key: string; // .env / variable key
  type: FieldType;
  label: string;
  hint?: string;
  required?: boolean;
  default?: string;
  min?: number;
  max?: number;
  regex?: string;
  options?: { value: string; label: string }[];
  /** Resolver token grammar (parsed by the install-time resolver), e.g.
   *  "password:32" | "base64:32" | "hex:64" | "passwordSymbols:24" | "uuid" | "jwt". */
  generate?: string;
  secret?: boolean;
}

/** A container port a service wants reachable — either via a domain (proxy) or a published host port.
 *  Populated from the compose file by the importer; here only `web` maps to it. */
export interface ExposePort {
  serviceName: string;
  containerPort: number;
  defaultMode: "domain" | "hostPort";
  public?: boolean;
}

/** A config file bind-mounted into a service (my.cnf, redis.conf, seed…). */
export interface ConfigMount {
  serviceName: string;
  target: string; // absolute container path
  content: string;
  mode?: string;
}

/** The full install manifest: gallery metadata + the (still-unresolved) compose + typed fields,
 *  static variables, exposure and mount metadata. `secrets` stays on the type for hand-authored
 *  back-compat, but `toManifest` never emits it — it folds secrets into `fields`. */
export interface TemplateManifest extends TemplateMeta {
  composeFile: string;
  variables?: Record<string, string>;
  fields?: FormField[];
  exposure?: ExposePort[];
  mounts?: ConfigMount[];
  secrets?: SecretSpec[];
}

/** Turn an env key into a readable label: `PASSWORD_64_APIKEY` → "Password 64 Apikey". */
function humanizeKey(key: string): string {
  const parts = key.split(/[_-]/).filter(Boolean);
  if (parts.length === 0) return key;
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

/** The resolver token that regenerates a secret of the given kind/length. Shared grammar with the
 *  install-time resolver - emitted here, parsed there. */
function generateToken(kind: SecretKind, len: number): string {
  switch (kind) {
    case "hex":
      return `hex:${len}`;
    case "base64":
      return `base64:${len}`;
    case "password-symbols":
      return `passwordSymbols:${len}`;
    default:
      return `password:${len}`; // "alnum"
  }
}

/** Map one legacy secret (bare key, or `{key,kind,len}`) to a typed form field. Mirrors
 *  `buildTemplateEnv`'s defaults (bare string ⇒ alnum/24) so the field regenerates the same value. */
function secretToField(s: SecretSpec): FormField {
  const key = typeof s === "string" ? s : s.key;
  const kind: SecretKind = typeof s === "string" ? "alnum" : s.kind ?? "alnum";
  const len = typeof s === "string" ? 24 : s.len ?? 24;
  // USER* keys are usernames, not sensitive — show them as plain text; still auto-generated if blank.
  const isUser = /^USER(NAME)?(_|$)/i.test(key);
  return {
    key,
    type: isUser ? "text" : "password",
    label: humanizeKey(key),
    required: false,
    generate: generateToken(kind, len),
    secret: !isUser,
  };
}

/**
 * Derive exposure metadata from a hand-authored (curated) compose's published ports, for templates that
 * carry neither `exposure` nor `web`. Line/indent based (no YAML dep). Only the `- "<host>:<container>"`
 * double-quoted form is recognised — exactly the shape `rewriteHostPorts` can renumber, so every returned
 * entry is rewrite-compatible. The FIRST published port (document order) is the primary `domain` target
 * (mirrors `inferComposeWeb`), so the manifest agrees with what deploy routes to; any further port is a
 * plain `hostPort`. A container port already seen is skipped (rewriteHostPorts matches by container port).
 */
export function deriveExposureFromCompose(compose: string): ExposePort[] {
  const out: ExposePort[] = [];
  const seen = new Set<number>();
  let inServices = false;
  let serviceIndent = -1;
  let service: string | null = null;
  let inPorts = false;
  let portsIndent = -1;
  for (const line of compose.split("\n")) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = /^services:\s*$/.test(line);
      service = null;
      inPorts = false;
      serviceIndent = -1;
      continue;
    }
    if (!inServices) continue;
    if (serviceIndent === -1) serviceIndent = indent;
    if (indent === serviceIndent) {
      const m = /^\s*([A-Za-z0-9._-]+):\s*$/.exec(line);
      service = m ? m[1] : null;
      inPorts = false;
      continue;
    }
    if (!service) continue;
    // Any `key:` line (bare or with a value) ends the previous block; only a bare `ports:` opens one.
    const key = /^(\s*)([A-Za-z0-9._-]+):(?:\s|$)/.exec(line);
    if (key) {
      inPorts = key[2] === "ports" && /^\s*ports:\s*$/.test(line);
      portsIndent = key[1].length;
      continue;
    }
    if (inPorts && indent >= portsIndent) {
      const item = /^\s*-\s*"(\d+):(\d+)"\s*$/.exec(line);
      if (!item) continue;
      const containerPort = Number(item[2]);
      if (seen.has(containerPort)) continue;
      seen.add(containerPort);
      const primary = out.length === 0;
      out.push({ serviceName: service, containerPort, defaultMode: primary ? "domain" : "hostPort", public: primary });
    }
  }
  return out;
}

/**
 * Map a legacy `TemplateDef` to a `TemplateManifest` (backward-compatible, lossless): its `secrets[]`
 * become typed `fields[]`, its static `env` becomes `variables` (minus any key a secret field owns),
 * and its `web` primary service becomes a single domain `exposure`. Empty optional sections are
 * omitted. `secrets` is NOT re-emitted (fields supersede it — the generate token encodes kind+len).
 */
export function toManifest(tpl: TemplateDef): TemplateManifest {
  const fields = (tpl.secrets ?? []).map(secretToField);
  const fieldKeys = new Set(fields.map((f) => f.key));

  // Static env defaults + any importer-emitted resolver variables (a field owns its own key).
  const variables: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...(tpl.variables ?? {}), ...(tpl.env ?? {}) })) {
    if (!fieldKeys.has(k)) variables[k] = v;
  }

  // Prefer the importer's explicit exposure metadata (v2); fall back to the `web` hint; finally (curated
  // templates carry neither) derive it from the compose's own published ports so the UI/deploy know the
  // web port and installs get a freshly allocated host port instead of the baked one.
  const exposure: ExposePort[] =
    tpl.exposure && tpl.exposure.length > 0
      ? tpl.exposure
      : tpl.web
        ? [{ serviceName: tpl.web.service, containerPort: tpl.web.port, defaultMode: "domain", public: true }]
        : deriveExposureFromCompose(tpl.composeFile);

  const mounts: ConfigMount[] = tpl.mounts ?? [];

  return {
    slug: tpl.slug,
    name: tpl.name,
    description: tpl.description,
    category: tpl.category,
    icon: tpl.icon,
    logo: tpl.logo,
    documentation: tpl.documentation,
    composeFile: tpl.composeFile,
    ...(fields.length ? { fields } : {}),
    ...(Object.keys(variables).length ? { variables } : {}),
    ...(exposure.length ? { exposure } : {}),
    ...(mounts.length ? { mounts } : {}),
  };
}

/** The client-facing manifest for the install form: field DEFINITIONS (never resolved secret
 *  values), exposure + variables + mount META (never the mount `content`). The raw `composeFile` is
 *  included only when the caller has write access (it can carry author intent worth editing but is
 *  otherwise gated like AppView.composeFile). */
export interface PublicManifest extends TemplateMeta {
  fields?: FormField[];
  exposure?: ExposePort[];
  variables?: Record<string, string>;
  mounts?: { serviceName: string; target: string; mode?: string }[];
  composeFile?: string;
}

export function publicManifest(m: TemplateManifest, canWrite: boolean): PublicManifest {
  return {
    slug: m.slug,
    name: m.name,
    description: m.description,
    category: m.category,
    icon: m.icon,
    logo: m.logo,
    documentation: m.documentation,
    ...(m.fields ? { fields: m.fields } : {}),
    ...(m.exposure ? { exposure: m.exposure } : {}),
    ...(m.variables ? { variables: m.variables } : {}),
    // Drop mount `content` — it is config-file data materialized at deploy, not needed by the form.
    ...(m.mounts ? { mounts: m.mounts.map(({ serviceName, target, mode }) => ({ serviceName, target, mode })) } : {}),
    ...(canWrite ? { composeFile: m.composeFile } : {}),
  };
}

/** Validate a user's install field values against the manifest's typed field definitions (required,
 *  number min/max, boolean, select options, regex). Unknown keys are allowed (forward-compat). The
 *  `regex`/`min`/`max` come from the manifest (author/importer-controlled, not the user) so they are
 *  ReDoS-safe. Throws BadRequestException on the first violation. */
export function validateInstallFields(
  fields: Record<string, string> | undefined,
  defs: FormField[] | undefined,
): void {
  if (!fields) return;
  const byKey = new Map((defs ?? []).map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(fields)) {
    const def = byKey.get(key);
    if (!def) continue; // unknown key → allowed (may be an env override the resolver ignores)
    const bad = (msg: string): never => {
      throw new BadRequestException(`invalid value for "${key}": ${msg}`);
    };
    if (value === "") {
      if (def.required && !def.generate) bad("required");
      continue; // empty + generate/optional → the server fills it
    }
    if (def.type === "number" || def.type === "port") {
      const n = Number(value);
      if (!Number.isFinite(n)) bad("must be a number");
      if (def.min != null && n < def.min) bad(`must be >= ${def.min}`);
      if (def.max != null && n > def.max) bad(`must be <= ${def.max}`);
    }
    if (def.type === "boolean" && value !== "true" && value !== "false") bad("must be true or false");
    if (def.options && !def.options.some((o) => o.value === value)) bad("not an allowed option");
    if (def.regex && !new RegExp(def.regex).test(value)) bad("does not match the required format");
  }
}

/**
 * Validate a config-mount's IN-CONTAINER target path before it becomes a bind-mount target in the
 * Tugra deploy override. The host SOURCE is always Tugra-controlled (`/etc/tugra/compose/<appId>/
 * mounts/<i>`), so the only attacker-influenced surface is this `target`. Reject anything that could
 * traverse or break out of the JSON-quoted YAML bind string. Throws BadRequestException.
 */
export function validateConfigMountTarget(target: string): void {
  const bad = (msg: string): never => {
    throw new BadRequestException(`invalid config mount target "${target}": ${msg}`);
  };
  if (typeof target !== "string" || target.trim() === "") bad("empty");
  // No control/quote chars — the target is JSON-quoted into the YAML bind (`"<host>:<target>:ro"`).
  if (/[\0\n\r"'`:]/.test(target)) bad("must not contain control, quote, or ':' characters");
  if (!posix.isAbsolute(target)) bad("must be an absolute path");
  if (target.split("/").some((seg) => seg === "..")) bad("must not contain '..'");
  if (target.endsWith("/")) bad("must be a file path, not a directory"); // normalize keeps trailing '/'
  // Reject any other non-canonical form (`//`, `/./`) so the host bind target is unambiguous.
  if (posix.normalize(target) !== target) bad("must be a normalized path");
}

/**
 * Validate a config-mount's `serviceName`. It becomes a raw YAML mapping key in the Tugra deploy
 * override (which is deliberately NOT run through assertSafeCompose), so an unconstrained value could
 * inject arbitrary compose directives (privileged, host binds, …) → host escape. Restrict it to the
 * compose service-name charset. Throws BadRequestException.
 */
export function validateConfigMountServiceName(serviceName: string): void {
  if (typeof serviceName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(serviceName)) {
    throw new BadRequestException(`invalid config mount service name "${serviceName}"`);
  }
}
