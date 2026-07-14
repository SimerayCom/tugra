import { z } from "zod";
import { verifyEd25519 } from "../servers/agent-auth";
import type { TemplateDef } from "../templates/catalog";

// Bound the untrusted remote body BEFORE any decode/parse so a hostile payload can't exhaust memory.
// The bundled catalog is ~620KB / ~280 templates; keep generous headroom.
export const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_TEMPLATES = 5000;

// Mirror catalog.ts `TemplateCategory` — the importer maps every template into exactly this set.
const CATEGORIES = [
  "cms", "automation", "database", "monitoring", "tools", "analytics", "security",
  "productivity", "developer", "ai", "media", "communication", "finance",
] as const;

const secretSpecSchema = z.union([
  z.string(),
  z.object({
    key: z.string(),
    kind: z.enum(["alnum", "hex", "base64", "password-symbols"]).optional(),
    len: z.number().int().positive().optional(),
  }),
]);

const templateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  category: z.enum(CATEGORIES),
  icon: z.string().optional(),
  logo: z.string().optional(),
  documentation: z.string().optional(),
  composeFile: z.string().refine((c) => /(^|\n)services:/.test(c), "composeFile must define services:"),
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.array(secretSpecSchema).optional(),
  web: z.object({ service: z.string(), port: z.number().int() }).optional(),
  exposure: z
    .array(
      z.object({
        serviceName: z.string(),
        containerPort: z.number().int(),
        defaultMode: z.enum(["domain", "hostPort"]),
        public: z.boolean().optional(),
      }),
    )
    .optional(),
  mounts: z
    .array(z.object({ serviceName: z.string(), target: z.string(), content: z.string(), mode: z.string().optional() }))
    .optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

const payloadSchema = z.object({
  version: z.string().min(1),
  templates: z.record(z.string(), templateSchema),
});

const envelopeSchema = z.object({ payload: z.string(), sig: z.string() });

export interface VerifiedCatalog {
  version: string;
  templates: Record<string, TemplateDef>;
}

/** A typed failure carrying a short machine reason (never the raw payload) for logging. */
export class CatalogVerifyError extends Error {
  constructor(public readonly reason: string) {
    super(`catalog verify failed: ${reason}`);
    this.name = "CatalogVerifyError";
  }
}

/**
 * Verify + validate an untrusted remote catalog body.
 *
 * VERIFY BEFORE PARSE — the only pre-auth parse is the tiny outer envelope (two bounded base64
 * strings). The ed25519 signature is checked over the TRANSPORTED `payload` string (no
 * re-serialization → no canonicalization ambiguity: the hub verifies the exact bytes it received).
 * The attacker's template JSON is base64-decoded + parsed ONLY after the signature passes.
 *
 * The signature (pinned publisher key) IS the trust boundary — a signed catalog is trusted like the
 * in-repo bundled catalog, which legitimately ships docker.sock / privileged / cap_add apps (portainer,
 * pi-hole, …). So the post-auth check is SHAPE validation + size/count caps, NOT `assertSafeCompose`
 * (that guard is for untrusted USER compose overrides and would reject those legitimate apps). Any
 * failure rejects the WHOLE blob — a partially-valid blob is suspicious.
 */
export function verifyCatalogEnvelope(rawBody: string, publisherKeyB64: string): VerifiedCatalog {
  if (typeof rawBody !== "string" || Buffer.byteLength(rawBody, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new CatalogVerifyError("body too large or not a string");
  }
  // (1) outer envelope only — the single pre-auth parse.
  let envelope: { payload: string; sig: string };
  try {
    envelope = envelopeSchema.parse(JSON.parse(rawBody));
  } catch {
    throw new CatalogVerifyError("malformed envelope");
  }
  // (2) verify the signature over the transported payload STRING (no reconstruction).
  if (!verifyEd25519(publisherKeyB64, envelope.payload, envelope.sig)) {
    throw new CatalogVerifyError("bad signature");
  }
  // (3) only now decode + parse the AUTHENTICATED payload.
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch {
    throw new CatalogVerifyError("malformed payload");
  }
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) throw new CatalogVerifyError("invalid template shape");
  const { version, templates } = parsed.data;
  if (Object.keys(templates).length > MAX_TEMPLATES) throw new CatalogVerifyError("too many templates");
  // The map key must match the template's own slug (avoid a key/slug spoof).
  for (const [key, tpl] of Object.entries(templates)) {
    if (tpl.slug !== key) throw new CatalogVerifyError(`slug/key mismatch for "${key}"`);
  }
  return { version, templates: templates as Record<string, TemplateDef> };
}
