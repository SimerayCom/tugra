import type { SecretKind, SecretSpec, TemplateDef, TemplateMeta } from "./catalog";

// A rich, install-time template model. Today's `TemplateDef` bakes host ports and localhost URLs at
// import time and offers no install configuration; the manifest is the shape that later App Store
// slices resolve at INSTALL time (typed user form, dynamic ports, real URLs, config mounts, signed
// remote catalog). This slice only adds the type model + a backward-compatible mapper — behaviour is
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
 *  never pre-filled back to the client (enforced by the manifest endpoint in a later slice). */
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
  /** Resolver token grammar (parsed by the install-time resolver in a later slice), e.g.
   *  "password:32" | "base64:32" | "hex:64" | "passwordSymbols:24" | "uuid" | "jwt". */
  generate?: string;
  secret?: boolean;
}

/** A container port a service wants reachable — either via a domain (proxy) or a published host port.
 *  Populated from the compose file by the importer in a later slice; here only `web` maps to it. */
export interface ExposePort {
  serviceName: string;
  containerPort: number;
  defaultMode: "domain" | "hostPort";
  public?: boolean;
}

/** A config file bind-mounted into a service (my.cnf, redis.conf, seed…). Wired by later slices. */
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
 *  install-time resolver (later slice) — emitted here, parsed there. */
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

  // Prefer the importer's explicit exposure metadata (v2); fall back to the `web` hint.
  const exposure: ExposePort[] =
    tpl.exposure && tpl.exposure.length > 0
      ? tpl.exposure
      : tpl.web
        ? [{ serviceName: tpl.web.service, containerPort: tpl.web.port, defaultMode: "domain", public: true }]
        : [];

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
