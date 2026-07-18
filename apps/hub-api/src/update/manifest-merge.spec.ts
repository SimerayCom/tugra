import { generateKeyPairSync } from "node:crypto";
import {
  buildChannelEntry,
  canonicalizeManifest,
  mergeManifest,
  seedToPrivateKey,
  derivePublicKeyB64,
  signAndSelfVerify,
  validateManifest,
} from "./manifest-merge";
import { verifyUpdateManifest, UpdateVerifyError } from "./update-manifest";

// A base64 32-byte ed25519 seed (the UPDATE_SIGNING_KEY format), and its derived public key.
function keypair(): { seedB64: string; publicKeyB64: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32); // last 32 bytes = seed
  const seedB64 = Buffer.from(seed).toString("base64");
  return { seedB64, publicKeyB64: derivePublicKeyB64(seedToPrivateKey(seedB64)) };
}

const PUBLISHED = "2026-07-18T00:00:00.000Z";

describe("manifest-merge", () => {
  it("signAndSelfVerify round-trips through the REAL consumer verifier", () => {
    const { seedB64, publicKeyB64 } = keypair();
    const entry = buildChannelEntry({
      version: "0.2.0",
      hubImage: "ghcr.io/mrcandev/tugra-hub:0.2.0",
      webImage: "ghcr.io/mrcandev/tugra-web:0.2.0",
      agentSha256: { amd64: "sha256:AABBCC", arm64: "ddeeff" },
      changelogUrl: "https://github.com/mrcandev/tugra/releases/tag/v0.2.0",
      publishedAt: PUBLISHED,
    });
    const { body, sig, publicKeyB64: pk } = signAndSelfVerify({ current: null, channel: "stable", entry, seedB64 });
    expect(pk).toBe(publicKeyB64);

    // The real hub verifier accepts exactly these bytes+sig+key.
    const verified = verifyUpdateManifest(body, sig, publicKeyB64);
    expect(verified.tugra.stable.version).toBe("0.2.0");
    // sha256: prefix stripped → bare lowercase hex.
    expect(verified.tugra.stable.agentSha256).toEqual({ amd64: "aabbcc", arm64: "ddeeff" });
  });

  it("a tampered body fails the consumer verifier", () => {
    const { seedB64, publicKeyB64 } = keypair();
    const entry = buildChannelEntry({ version: "1.0.0" });
    const { body, sig } = signAndSelfVerify({ current: null, channel: "stable", entry, seedB64 });
    const tampered = body.replace("1.0.0", "9.9.9");
    expect(() => verifyUpdateManifest(tampered, sig, publicKeyB64)).toThrow(UpdateVerifyError);
  });

  it("the canonical body has NO trailing newline and is byte-deterministic", () => {
    const { seedB64 } = keypair();
    const entry = buildChannelEntry({ version: "1.2.3" });
    const a = signAndSelfVerify({ current: null, channel: "stable", entry, seedB64 });
    const b = signAndSelfVerify({ current: null, channel: "stable", entry, seedB64 });
    expect(a.body.endsWith("\n")).toBe(false);
    expect(a.body.charCodeAt(a.body.length - 1)).not.toBe(0x0a);
    expect(a.body).toBe(b.body); // deterministic (sorted keys)
  });

  it("merge patches only the released channel and preserves the others byte-for-byte", () => {
    const current = { tugra: { beta: { version: "0.9.0-beta.3", notes: "keep me" } } };
    const entry = buildChannelEntry({ version: "0.2.0" });
    const merged = mergeManifest(current, "stable", entry);
    expect(merged.tugra.beta).toEqual({ version: "0.9.0-beta.3", notes: "keep me" });
    expect(merged.tugra.stable.version).toBe("0.2.0");
  });

  it("first-ever release (no current manifest) starts a fresh channel map", () => {
    const merged = mergeManifest(undefined, "stable", buildChannelEntry({ version: "0.1.0" }));
    expect(Object.keys(merged.tugra)).toEqual(["stable"]);
    expect(mergeManifest({}, "stable", buildChannelEntry({ version: "0.1.0" })).tugra.stable.version).toBe("0.1.0");
  });

  it("validateManifest is fail-closed on a bad changelogUrl", () => {
    // buildChannelEntry forwards the value; a non-URL must be rejected BEFORE signing.
    const bad = { tugra: { stable: { version: "1.0.0", changelogUrl: "not-a-url" } } };
    expect(() => validateManifest(bad)).toThrow(/schema validation/);
  });

  it("omits minUpgradeFrom entirely when empty (never emits '' — would brick the channel)", () => {
    const entry = buildChannelEntry({ version: "2.0.0", minUpgradeFrom: "   " });
    expect("minUpgradeFrom" in entry).toBe(false);
    const withVal = buildChannelEntry({ version: "2.0.0", minUpgradeFrom: "1.9.0" });
    expect(withVal.minUpgradeFrom).toBe("1.9.0");
    // and it survives a round-trip
    const { seedB64, publicKeyB64 } = keypair();
    const { body, sig } = signAndSelfVerify({ current: null, channel: "stable", entry: withVal, seedB64 });
    expect(verifyUpdateManifest(body, sig, publicKeyB64).tugra.stable.minUpgradeFrom).toBe("1.9.0");
  });

  it("signAndSelfVerify throws (publishes nothing) if the merged manifest is invalid", () => {
    const { seedB64 } = keypair();
    // An entry the schema rejects (empty version) must abort before producing any bytes.
    const badEntry = { version: "" } as ReturnType<typeof buildChannelEntry>;
    expect(() => signAndSelfVerify({ current: null, channel: "stable", entry: badEntry, seedB64 })).toThrow();
  });

  it("canonicalizeManifest sorts channel + field keys deterministically", () => {
    const m = validateManifest({
      tugra: { stable: { version: "1.0.0", changelogUrl: "https://x.io/c", notes: "n" }, beta: { version: "1.1.0-beta" } },
    });
    const body = canonicalizeManifest(m);
    // beta sorts before stable; within an entry, changelogUrl < notes < version.
    expect(body.indexOf('"beta"')).toBeLessThan(body.indexOf('"stable"'));
    expect(body.indexOf('"changelogUrl"')).toBeLessThan(body.indexOf('"notes"'));
  });
});
