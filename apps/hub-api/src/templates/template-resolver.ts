import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { magicDomain } from "../applications/magic-domain";
import { genSecret } from "./catalog";
import type { TemplateManifest } from "./template-manifest";

// Install-time resolver for a TemplateManifest: turns its `fields` (user-facing, generate-on-blank)
// and `variables` (${token} strings) into a concrete env record. Pure — the caller passes everything
// via ctx (server IPs, magic suffix, allocated ports, user field values); it never reads config/DB.
// Parity with Dokploy's processors.ts, but stronger: CSPRNG secrets (genSecret), a real order-
// independent dependency resolution with cycle detection (Dokploy's two linear passes silently emit
// raw tokens when a referenced var is declared later), and a hand-rolled HS256 JWT (jsonwebtoken is
// not resolvable from a pure hub module). Nothing consumes this yet — createFromTemplate v2 wires it.

const TOKEN_RE = /\$\{([^}]+)\}/g; // ${inner}, inner has no '}' (linear scan → no ReDoS)
const JWT_TTL_SECONDS = 10 * 365 * 24 * 3600; // 10 years — install tokens are long-lived by default

export interface ResolveCtx {
  appName: string; // used as the magic-domain slug source
  publicIp?: string | null;
  publicIpv6?: string | null;
  wildcardDomain?: string | null;
  magicSuffix?: string | null; // resolved by the caller (server.magicSuffix ?? env ?? "sslip.io")
  allocatedPorts?: Record<string, number>; // "service:containerPort" → host port (later slice fills this)
  userFields?: Record<string, string>; // user-supplied overrides for fields
}

type ManifestVars = Pick<TemplateManifest, "fields" | "variables">;

/** URL-safe base64 (no padding) of a UTF-8 string — the JWT segment encoding. */
function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** A minimal HS256 JWT: header.payload.signature, signed with `secret` as the HMAC key. The caller's
 *  payload fields override the defaults (iss/iat/exp). */
function signJwt(payload: Record<string, unknown>, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: "tugra", iat: now, exp: now + JWT_TTL_SECONDS, ...payload }));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

/** Parse the `:N` length suffix of a generator token, falling back to `def` when absent/invalid. */
function parseLen(rest: string, def: number): number {
  const n = Number.parseInt(rest, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Resolve one token (the inner text of `${...}`, or a field's bare `generate` string). Returns the
 * generated value, or `null` when the token is not a recognized generator (the caller then treats it
 * as a `${VAR}` cross-reference or leaves it literal). `resolveDep(name)` returns another key's
 * already-resolved value, or undefined when the name is not a known field/variable.
 */
function generateValue(
  token: string,
  ctx: ResolveCtx,
  resolveDep: (name: string) => string | undefined,
): string | null {
  switch (token) {
    case "uuid":
      return randomUUID();
    case "timestamp":
    case "timestampms":
      return String(Date.now());
    case "timestamps":
      return String(Math.floor(Date.now() / 1000));
    case "domain":
      return (
        magicDomain({
          name: ctx.appName,
          publicIp: ctx.publicIp,
          publicIpv6: ctx.publicIpv6,
          wildcardDomain: ctx.wildcardDomain,
          suffix: ctx.magicSuffix,
        }) ?? "" // no public IP → no domain (SSRF-safe); a later slice supplies real ctx
      );
    case "jwt":
      return signJwt({}, randomBytes(32).toString("hex")); // fresh, discarded secret → opaque token
    default:
      break;
  }

  const ci = token.indexOf(":");
  if (ci === -1) return null; // no other bare tokens
  const head = token.slice(0, ci);
  const rest = token.slice(ci + 1);

  switch (head) {
    case "password":
      return genSecret("alnum", parseLen(rest, 24));
    case "passwordSymbols":
      return genSecret("password-symbols", parseLen(rest, 24));
    case "base64":
      return genSecret("base64", parseLen(rest, 32));
    case "hex":
      return genSecret("hex", parseLen(rest, 32));
    case "port":
      // rest = "service:containerPort" → the allocated host port, or "" until allocation runs.
      return String(ctx.allocatedPorts?.[rest] ?? "");
    case "jwt": {
      // rest = "SECRET" or "SECRET:PAYLOAD_VAR". SECRET names a variable whose resolved value is the
      // HMAC key (or, if unknown, the literal text). PAYLOAD_VAR names a variable whose resolved
      // value is JSON claims.
      const sep = rest.indexOf(":");
      const secretRef = sep === -1 ? rest : rest.slice(0, sep);
      const payloadRef = sep === -1 ? undefined : rest.slice(sep + 1);
      // Choose the HMAC key. A non-empty resolved variable value wins; an UNKNOWN secretRef is an
      // inline literal secret. A known-but-EMPTY secret (e.g. a blank field) or no ref at all falls
      // back to a fresh random key — never the predictable variable NAME, which would be a forgeable
      // (attacker-guessable) signing key.
      const depVal = secretRef ? resolveDep(secretRef) : undefined;
      const secret =
        depVal !== undefined && depVal !== ""
          ? depVal
          : depVal === undefined && secretRef
            ? secretRef
            : randomBytes(32).toString("hex");
      let payload: Record<string, unknown> = {};
      if (payloadRef) {
        const pv = resolveDep(payloadRef) ?? payloadRef;
        if (pv.trim().startsWith("{")) {
          try {
            payload = JSON.parse(pv) as Record<string, unknown>;
          } catch {
            payload = {}; // malformed claims → sign an empty payload rather than throw
          }
        }
      }
      return signJwt(payload, secret);
    }
    default:
      return null;
  }
}

/**
 * Resolve a manifest's fields + variables into a concrete env record. Fields are leaves (user value,
 * else generated, else default); variables are resolved by a memoized depth-first walk so a `${VAR}`
 * reference works regardless of declaration order and each named value is generated exactly once. A
 * circular reference is detected and left as a raw `${...}` token rather than looping forever. On a
 * field/variable key collision the field wins (it is the authoritative, user-facing value).
 */
export function resolveVariables(manifest: ManifestVars, ctx: ResolveCtx): Record<string, string> {
  const fields = manifest.fields ?? [];
  const variables = manifest.variables ?? {};
  const resolved: Record<string, string> = {};

  const known = (k: string): boolean =>
    Object.prototype.hasOwnProperty.call(resolved, k) || Object.prototype.hasOwnProperty.call(variables, k);

  const resolve = (key: string, stack: Set<string>): string => {
    if (Object.prototype.hasOwnProperty.call(resolved, key)) return resolved[key];
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return `\${${key}}`; // unknown key → literal
    if (stack.has(key)) return `\${${key}}`; // cycle → leave raw, halt
    const next = new Set(stack).add(key);
    const dep = (name: string): string | undefined => (known(name) ? resolve(name, next) : undefined);
    const out = variables[key].replace(TOKEN_RE, (m, inner: string) => {
      const g = generateValue(inner, ctx, dep);
      if (g !== null) return g;
      return known(inner) ? resolve(inner, next) : m; // ${VAR} reference, else leave literal
    });
    resolved[key] = out;
    return out;
  };

  // Seed fields first (leaves) so variables can reference them by ${KEY}.
  for (const f of fields) {
    const override = ctx.userFields?.[f.key];
    if (override !== undefined && override !== "") {
      resolved[f.key] = override;
    } else if (f.generate) {
      const dep = (name: string): string | undefined => (known(name) ? resolve(name, new Set([f.key])) : undefined);
      resolved[f.key] = generateValue(f.generate, ctx, dep) ?? f.default ?? "";
    } else {
      resolved[f.key] = f.default ?? "";
    }
  }

  for (const key of Object.keys(variables)) resolve(key, new Set());
  return resolved;
}
