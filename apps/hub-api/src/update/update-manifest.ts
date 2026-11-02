import { z } from "zod";
import { verifyEd25519 } from "../servers/agent-auth";

// Bound the untrusted remote bodies BEFORE any decode/parse so a hostile origin can't exhaust memory.
// A versions.json is tiny (a handful of channels); 256 KB is enormous headroom. An ed25519 signature is
// 64 bytes → 88 base64 chars, so a 512-byte cap on the detached .sig is generous.
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_SIG_BYTES = 512;

/**
 * One published release for a channel. `version` + `changelogUrl` are all the version CHECK reads today;
 * the image refs / agent digests / minUpgradeFrom / publishedAt are carried for a later updater
 * (Dilim 11 pull→migrate→recreate) and are validated-but-unused here (forward-compat, reserved).
 */
export const channelEntrySchema = z.object({
  version: z.string().min(1),
  hubImage: z.string().optional(), // reserved (updater)
  webImage: z.string().optional(), // reserved (updater)
  agentSha256: z.record(z.string(), z.string()).optional(), // reserved (updater): arch → sha256
  minUpgradeFrom: z.string().optional(), // reserved (updater): refuse to skip past this
  publishedAt: z.string().optional(), // reserved (updater/freshness)
  changelogUrl: z.string().url().optional(),
  notes: z.string().optional(),
});

/** Max length of an operator notice message (plain text). Bounded well under MAX_MANIFEST_BYTES. */
export const NOTICE_MESSAGE_MAX = 500;

/**
 * An operator-authored announcement banner, delivered through the SAME signed manifest and shown by the
 * hub to the instance owner — decoupled from releases (TOP-LEVEL, a sibling of `tugra`), so it is readable
 * even when the instance's tracked channel has no entry, and is NOT wiped when a channel is released.
 */
export const noticeSchema = z.object({
  id: z.string().min(1).max(64), // stable id; the UI remembers per-viewer dismissal by it, a new id re-shows
  message: z.string().min(1).max(NOTICE_MESSAGE_MAX), // PLAIN TEXT — never rendered as HTML
  severity: z.enum(["info", "warning", "critical"]).default("info"),
  // https-only: z.string().url() alone ACCEPTS javascript:/data: URLs — the refine is the real gate.
  url: z.string().url().max(2048).refine((u) => u.startsWith("https://"), "notice url must be https").optional(),
  expiresAt: z.string().datetime().optional(), // ISO 8601; the consumer ignores an expired notice
});

// `tugra` maps a channel name ("stable" | "beta" | …) → its latest published entry. Open record so a new
// channel never fails validation; the service only reads the channel the instance is configured to track.
// `notice` is an optional top-level operator banner (see noticeSchema) — optional so old hubs/manifests
// keep working (z.object is non-strict: an unknown key is stripped, never rejected).
export const manifestSchema = z.object({
  tugra: z.record(z.string(), channelEntrySchema),
  notice: noticeSchema.optional(),
});

export type ChannelEntry = z.infer<typeof channelEntrySchema>;
export type Notice = z.infer<typeof noticeSchema>;
export interface VerifiedManifest {
  tugra: Record<string, ChannelEntry>;
  notice?: Notice;
}

/** A typed failure carrying a short machine reason (never the raw body) for logging. */
export class UpdateVerifyError extends Error {
  constructor(public readonly reason: string) {
    super(`update manifest verify failed: ${reason}`);
    this.name = "UpdateVerifyError";
  }
}

/**
 * Verify + validate an untrusted remote version manifest with its DETACHED ed25519 signature.
 *
 * VERIFY BEFORE PARSE — the signature is checked over the EXACT transported manifest bytes before the
 * JSON is ever parsed, so a malicious payload's JSON is never fed to the parser pre-auth.
 *
 * Detached (versions.json + versions.json.sig) rather than an inline `{payload, sig}` envelope so the
 * SAME plain manifest is readable byte-for-byte by both this hub AND the bash installer (Dilim 4) — they
 * verify identical bytes. That makes byte-canonicalisation the trust contract: the reference signer signs
 * `versions.json` verbatim (valid UTF-8, no BOM, no added trailing newline) and consumers verify the
 * bytes they received. We therefore MUST NOT trim/normalise `rawManifest` (any byte change breaks the
 * signature forever). The `.sig` file, by contrast, is base64 text that routinely carries a trailing
 * newline, so trimming it is safe and expected.
 */
export function verifyUpdateManifest(rawManifest: string, rawSig: string, publisherKeyB64: string): VerifiedManifest {
  if (typeof rawManifest !== "string" || Buffer.byteLength(rawManifest, "utf8") > MAX_MANIFEST_BYTES) {
    throw new UpdateVerifyError("manifest too large or not a string");
  }
  if (typeof rawSig !== "string" || Buffer.byteLength(rawSig, "utf8") > MAX_SIG_BYTES) {
    throw new UpdateVerifyError("signature too large or not a string");
  }
  // (1) verify the detached signature over the EXACT manifest bytes — the only gate before any parse.
  if (!verifyEd25519(publisherKeyB64, rawManifest, rawSig.trim())) {
    throw new UpdateVerifyError("bad signature");
  }
  // (2) only now parse the AUTHENTICATED manifest.
  let raw: unknown;
  try {
    raw = JSON.parse(rawManifest);
  } catch {
    throw new UpdateVerifyError("malformed manifest");
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new UpdateVerifyError("invalid manifest shape");
  return parsed.data;
}
