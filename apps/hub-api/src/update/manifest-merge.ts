import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import {
  channelEntrySchema,
  manifestSchema,
  verifyUpdateManifest,
  type ChannelEntry,
  type VerifiedManifest,
} from "./update-manifest";

// ASN.1 PKCS#8 prefix for an ed25519 private key; the 32-byte seed follows (hub-signing.service pattern).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Release-time producer core for the signed update manifest. Pure + dependency-free so it unit-tests
 * against the SAME `verifyUpdateManifest` / `manifestSchema` the hub enforces — the only guarantee that
 * what we publish is byte-for-byte acceptable to every consumer (hub + bash installer). No I/O here;
 * the committed `scripts/sign-manifest.mjs` runner does the file reads/writes.
 */

export interface ChannelEntryInput {
  version: string;
  hubImage?: string;
  webImage?: string;
  agentSha256?: Record<string, string>; // arch → digest ("sha256:…" or bare hex)
  minUpgradeFrom?: string;
  publishedAt?: string;
  changelogUrl?: string;
  notes?: string;
}

/** Strip a leading `sha256:` → bare lowercase hex (what the manifest's agentSha256 field stores). */
function bareHex(digest: string): string {
  return digest.replace(/^sha256:/i, "").toLowerCase();
}

/**
 * Assemble a schema-clean ChannelEntry from release inputs. Empty optionals are OMITTED entirely —
 * critically `minUpgradeFrom`: a present-but-empty/garbage value makes the updater return
 * `needs-intermediate` and BLOCK the whole channel (updater.service.ts). Absent = no restriction.
 */
export function buildChannelEntry(input: ChannelEntryInput): ChannelEntry {
  const entry: ChannelEntry = { version: input.version };
  if (input.hubImage) entry.hubImage = input.hubImage;
  if (input.webImage) entry.webImage = input.webImage;
  if (input.agentSha256 && Object.keys(input.agentSha256).length > 0) {
    entry.agentSha256 = Object.fromEntries(
      Object.entries(input.agentSha256).map(([arch, digest]) => [arch, bareHex(digest)]),
    );
  }
  if (input.minUpgradeFrom && input.minUpgradeFrom.trim()) entry.minUpgradeFrom = input.minUpgradeFrom.trim();
  if (input.publishedAt) entry.publishedAt = input.publishedAt;
  if (input.changelogUrl) entry.changelogUrl = input.changelogUrl;
  if (input.notes) entry.notes = input.notes;
  return entry;
}

/**
 * Patch ONLY `tugra[channel]` into the current manifest, preserving every other channel byte-for-byte.
 * Tolerant of an absent/empty/first-run `current` (starts from an empty channel map).
 */
export function mergeManifest(current: unknown, channel: string, entry: ChannelEntry): VerifiedManifest {
  const base: Record<string, ChannelEntry> = {};
  if (current && typeof current === "object" && "tugra" in current) {
    const tugra = (current as { tugra: unknown }).tugra;
    if (tugra && typeof tugra === "object") {
      Object.assign(base, tugra as Record<string, ChannelEntry>);
    }
  }
  base[channel] = entry;
  return { tugra: base };
}

/** Validate against the SAME schema the consumer enforces (fail-closed). Returns the parsed data. */
export function validateManifest(obj: unknown): VerifiedManifest {
  const parsed = manifestSchema.safeParse(obj);
  if (!parsed.success) throw new Error(`manifest failed schema validation: ${parsed.error.message}`);
  return parsed.data;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

/**
 * Deterministic canonical bytes: sorted keys, UTF-8, NO trailing newline. This is EXACTLY what gets
 * signed and written to versions.json — any byte drift breaks the detached signature forever.
 */
export function canonicalizeManifest(manifest: VerifiedManifest): string {
  return JSON.stringify(sortKeys(manifest));
}

/** base64 32-byte seed → ed25519 private KeyObject. */
export function seedToPrivateKey(seedB64: string): KeyObject {
  const seed = Buffer.from(seedB64, "base64");
  if (seed.length !== 32) throw new Error("signing key must be a base64-encoded 32-byte ed25519 seed");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** The publisher public key operators set as UPDATE_PUBLISHER_KEY (base64 SPKI DER, 44 bytes). */
export function derivePublicKeyB64(priv: KeyObject): string {
  return createPublicKey(priv).export({ format: "der", type: "spki" }).toString("base64");
}

/** Detached ed25519 signature (base64) over the exact body bytes. */
export function signDetached(priv: KeyObject, body: string): string {
  return sign(null, Buffer.from(body), priv).toString("base64");
}

export interface SignedManifest {
  body: string; // versions.json bytes — write verbatim, NO trailing newline
  sig: string; // base64 detached signature (.sig file)
  publicKeyB64: string; // UPDATE_PUBLISHER_KEY
}

/**
 * The signing choke-point: merge → validate (fail-closed) → canonicalize the PARSED object → sign →
 * and PROVE the real consumer verifier accepts the exact bytes+sig+key before returning. Throws (so the
 * runner publishes nothing) on any failure, so a manifest that wouldn't verify downstream can never ship.
 */
export function signAndSelfVerify(args: {
  current: unknown;
  channel: string;
  entry: ChannelEntry;
  seedB64: string;
}): SignedManifest {
  const merged = mergeManifest(args.current, args.channel, args.entry);
  const validated = validateManifest(merged); // fail-closed against the shared schema
  const body = canonicalizeManifest(validated); // deterministic, no trailing newline
  const priv = seedToPrivateKey(args.seedB64);
  const sig = signDetached(priv, body);
  const publicKeyB64 = derivePublicKeyB64(priv);
  verifyUpdateManifest(body, sig, publicKeyB64); // throws UpdateVerifyError on any mismatch → never publish
  return { body, sig, publicKeyB64 };
}

// Re-export so the runner can validate an entry shape if needed without a second import.
export { channelEntrySchema };
