import { generateKeyPairSync } from "node:crypto";
import {
  assertRequiredDigests,
  buildChannelEntry,
  buildNotice,
  canonicalizeManifest,
  mergeManifest,
  seedToPrivateKey,
  derivePublicKeyB64,
  signAndSelfVerify,
  validateManifest,
} from "./manifest-merge";
import { verifyUpdateManifest, UpdateVerifyError, type Notice } from "./update-manifest";

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
      hubImage: "ghcr.io/simeraycom/tugra-hub:0.2.0",
      webImage: "ghcr.io/simeraycom/tugra-web:0.2.0",
      agentSha256: { amd64: "sha256:AABBCC", arm64: "ddeeff" },
      changelogUrl: "https://github.com/SimerayCom/tugra/releases/tag/v0.2.0",
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

  it("buildNotice omits empty optionals and defaults severity to info", () => {
    expect(buildNotice({ id: "a", message: "m" })).toEqual({ id: "a", message: "m", severity: "info" });
    expect(buildNotice({ id: "a", message: "m", severity: "critical", url: " https://x.io ", expiresAt: " 2026-12-01T00:00:00Z " })).toEqual({
      id: "a",
      message: "m",
      severity: "critical",
      url: "https://x.io",
      expiresAt: "2026-12-01T00:00:00Z",
    });
  });

  it("carries an existing notice FORWARD across a channel release (notice arg omitted)", () => {
    const { seedB64, publicKeyB64 } = keypair();
    const current = {
      tugra: { beta: buildChannelEntry({ version: "0.1.0-beta.1" }) },
      notice: { id: "n1", message: "hi", severity: "info" },
    };
    const { body, sig } = signAndSelfVerify({
      current,
      channel: "beta",
      entry: buildChannelEntry({ version: "0.1.0-beta.2" }),
      seedB64,
    });
    const v = verifyUpdateManifest(body, sig, publicKeyB64);
    expect(v.tugra.beta.version).toBe("0.1.0-beta.2");
    expect(v.notice).toEqual({ id: "n1", message: "hi", severity: "info" });
  });

  it("SET a notice (notice-only run: channel/entry null) preserves all channels", () => {
    const { seedB64, publicKeyB64 } = keypair();
    const current = {
      tugra: { beta: buildChannelEntry({ version: "0.1.0-beta.1" }), stable: buildChannelEntry({ version: "1.0.0" }) },
    };
    const notice = buildNotice({ id: "n2", message: "please update", severity: "warning", url: "https://tugra.io/x" });
    const { body, sig } = signAndSelfVerify({ current, channel: null, entry: null, notice, seedB64 });
    const v = verifyUpdateManifest(body, sig, publicKeyB64);
    expect(Object.keys(v.tugra).sort()).toEqual(["beta", "stable"]);
    expect(v.notice).toEqual({ id: "n2", message: "please update", severity: "warning", url: "https://tugra.io/x" });
  });

  it("CLEAR a notice (notice: null) removes it but keeps channels", () => {
    const { seedB64, publicKeyB64 } = keypair();
    const current = {
      tugra: { beta: buildChannelEntry({ version: "0.1.0-beta.1" }) },
      notice: { id: "n1", message: "x", severity: "info" },
    };
    const { body, sig } = signAndSelfVerify({ current, channel: null, entry: null, notice: null, seedB64 });
    const v = verifyUpdateManifest(body, sig, publicKeyB64);
    expect(v.notice).toBeUndefined();
    expect(v.tugra.beta.version).toBe("0.1.0-beta.1");
    expect(body.includes("notice")).toBe(false);
  });

  it("signAndSelfVerify refuses a notice with a non-https url (fail-closed)", () => {
    const { seedB64 } = keypair();
    const current = { tugra: { beta: buildChannelEntry({ version: "0.1.0-beta.1" }) } };
    const bad: Notice = { id: "n", message: "m", severity: "info", url: "javascript:alert(1)" };
    expect(() => signAndSelfVerify({ current, channel: null, entry: null, notice: bad, seedB64 })).toThrow();
  });

  it("canonical body orders top-level notice before tugra", () => {
    const m = validateManifest({
      tugra: { stable: { version: "1.0.0" } },
      notice: { id: "n", message: "m", severity: "info" },
    });
    const body = canonicalizeManifest(m);
    expect(body.indexOf('"notice"')).toBeLessThan(body.indexOf('"tugra"'));
  });
});

describe("manifest-merge imageDigests (supply chain: digest-pinned updates)", () => {
  const H = "a".repeat(64);
  const W = "b".repeat(64);
  const U = "c".repeat(64);
  const A = "d".repeat(64);

  it("buildChannelEntry strips sha256:, lowercases, and keeps hub/web/updater/agent", () => {
    const e = buildChannelEntry({
      version: "0.2.0",
      imageDigests: { hub: `sha256:${H.toUpperCase()}`, web: W, updater: ` sha256:${U} `, agent: A },
    });
    expect(e.imageDigests).toEqual({ hub: H, web: W, updater: U, agent: A });
  });

  it("omits imageDigests when none/empty are given (old-shape entry, no stray key)", () => {
    expect("imageDigests" in buildChannelEntry({ version: "1.0.0" })).toBe(false);
    expect("imageDigests" in buildChannelEntry({ version: "1.0.0", imageDigests: {} })).toBe(false);
    expect("imageDigests" in buildChannelEntry({ version: "1.0.0", imageDigests: { hub: "", web: undefined } })).toBe(false);
  });

  it("THROWS at sign time on a non-64-hex digest (fail closed)", () => {
    expect(() => buildChannelEntry({ version: "1.0.0", imageDigests: { hub: "a".repeat(63) } })).toThrow(/imageDigests\.hub/);
    expect(() => buildChannelEntry({ version: "1.0.0", imageDigests: { web: "g".repeat(64) } })).toThrow(/imageDigests\.web/);
    expect(() => buildChannelEntry({ version: "1.0.0", imageDigests: { updater: `sha256:${"a".repeat(65)}` } })).toThrow();
  });

  it("round-trips through the REAL consumer verifier; canonical bytes are sorted-key stable", () => {
    const { seedB64, publicKeyB64 } = keypair();
    const entry = buildChannelEntry({ version: "0.2.0", imageDigests: { web: W, hub: H, agent: A, updater: U } });
    const a = signAndSelfVerify({ current: null, channel: "stable", entry, seedB64 });
    const b = signAndSelfVerify({ current: null, channel: "stable", entry, seedB64 });
    expect(a.body).toBe(b.body);
    expect(a.body).toContain(`"imageDigests":{"agent":"${A}","hub":"${H}","updater":"${U}","web":"${W}"}`);
    expect(verifyUpdateManifest(a.body, a.sig, publicKeyB64).tugra.stable.imageDigests).toEqual({ hub: H, web: W, updater: U, agent: A });
  });

  it("an old-shape manifest (no imageDigests) still verifies and carries none", () => {
    const { seedB64, publicKeyB64 } = keypair();
    const { body, sig } = signAndSelfVerify({ current: null, channel: "stable", entry: buildChannelEntry({ version: "0.1.0" }), seedB64 });
    expect(verifyUpdateManifest(body, sig, publicKeyB64).tugra.stable.imageDigests).toBeUndefined();
  });

  it("CONSUME-time: validateManifest rejects an uppercase / short / prefixed digest that bypassed the builder", () => {
    for (const bad of [H.toUpperCase(), "a".repeat(63), `sha256:${H}`]) {
      expect(() => validateManifest({ tugra: { stable: { version: "1.0.0", imageDigests: { hub: bad } } } })).toThrow(/schema validation/);
    }
    expect(validateManifest({ tugra: { stable: { version: "1.0.0", imageDigests: { hub: H } } } }).tugra.stable.imageDigests).toEqual({ hub: H });
  });

  it("merge preserves another channel's digests byte-for-byte", () => {
    const betaEntry = buildChannelEntry({ version: "0.9.0-beta.1", imageDigests: { hub: H, web: W } });
    const merged = mergeManifest({ tugra: { beta: betaEntry } }, "stable", buildChannelEntry({ version: "1.0.0" }));
    expect(merged.tugra.beta.imageDigests).toEqual({ hub: H, web: W });
  });

  it("assertRequiredDigests demands BOTH hub and web (the pair the updater pins)", () => {
    expect(() => assertRequiredDigests(buildChannelEntry({ version: "1.0.0" }))).toThrow(/hub, web/);
    expect(() => assertRequiredDigests(buildChannelEntry({ version: "1.0.0", imageDigests: { hub: H } }))).toThrow(/web/);
    expect(() => assertRequiredDigests(buildChannelEntry({ version: "1.0.0", imageDigests: { hub: H, web: W } }))).not.toThrow();
  });
});
