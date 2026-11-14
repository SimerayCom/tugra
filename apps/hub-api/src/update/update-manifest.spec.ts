import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { MAX_MANIFEST_BYTES, MAX_SIG_BYTES, UpdateVerifyError, verifyUpdateManifest } from "./update-manifest";

function keypair(): { priv: KeyObject; pubB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pubB64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}

/** Sign the EXACT manifest bytes (detached), returning the base64 signature. */
function detachedSig(priv: KeyObject, rawManifest: string): string {
  return sign(null, Buffer.from(rawManifest), priv).toString("base64");
}

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    tugra: {
      stable: { version: "0.2.0", hubImage: "ghcr.io/tugra/hub:0.2.0", changelogUrl: "https://get.tugra.io/changelog", ...over },
    },
  });

describe("verifyUpdateManifest", () => {
  const { priv, pubB64 } = keypair();

  it("returns the verified manifest for a valid detached signature", () => {
    const raw = manifest();
    const out = verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64);
    expect(out.tugra.stable.version).toBe("0.2.0");
    expect(out.tugra.stable.changelogUrl).toBe("https://get.tugra.io/changelog");
  });

  it("tolerates a trailing newline on the .sig (trimmed) but NOT on the manifest", () => {
    const raw = manifest();
    // sig with trailing whitespace still verifies (we trim the sig)
    expect(() => verifyUpdateManifest(raw, detachedSig(priv, raw) + "\n", pubB64)).not.toThrow();
    // a manifest with an EXTRA trailing newline was NOT what was signed → must fail (bytes differ)
    expect(() => verifyUpdateManifest(raw + "\n", detachedSig(priv, raw), pubB64)).toThrow(/bad signature/);
  });

  it("rejects a signature made over different bytes (tamper after signing)", () => {
    const raw = manifest();
    const sig = detachedSig(priv, raw);
    const tampered = manifest({ version: "9.9.9" }); // attacker swaps the version but keeps the old sig
    expect(() => verifyUpdateManifest(tampered, sig, pubB64)).toThrow(UpdateVerifyError);
    expect(() => verifyUpdateManifest(tampered, sig, pubB64)).toThrow(/bad signature/);
  });

  it("rejects a signature from the wrong publisher key", () => {
    const raw = manifest();
    const other = keypair();
    expect(() => verifyUpdateManifest(raw, detachedSig(other.priv, raw), pubB64)).toThrow(/bad signature/);
  });

  it("VERIFY-BEFORE-PARSE: garbage-JSON body with a wrong-key sig fails on the SIGNATURE, not a parse", () => {
    // The body is invalid JSON; if we parsed before verifying, this would throw a parse error. Instead a
    // wrong-key signature over it must be rejected at the signature gate — proving the body is never parsed.
    const garbage = "{ not: json";
    const wrong = keypair();
    expect(() => verifyUpdateManifest(garbage, detachedSig(wrong.priv, garbage), pubB64)).toThrow(/bad signature/);
  });

  it("rejects a malformed-but-VALIDLY-SIGNED body after the signature passes", () => {
    const garbage = "{ not: json"; // correctly signed by the real key, but not JSON
    expect(() => verifyUpdateManifest(garbage, detachedSig(priv, garbage), pubB64)).toThrow(/malformed manifest/);
  });

  it("rejects a validly-signed body with the wrong shape (missing version)", () => {
    const raw = JSON.stringify({ tugra: { stable: { changelogUrl: "https://x/y" } } });
    expect(() => verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64)).toThrow(/invalid manifest shape/);
  });

  it("rejects an oversize manifest before verifying", () => {
    const huge = "x".repeat(MAX_MANIFEST_BYTES + 1);
    expect(() => verifyUpdateManifest(huge, "AA==", pubB64)).toThrow(/manifest too large/);
  });

  it("rejects an oversize signature before verifying", () => {
    const raw = manifest();
    const huge = "A".repeat(MAX_SIG_BYTES + 1);
    expect(() => verifyUpdateManifest(raw, huge, pubB64)).toThrow(/signature too large/);
  });

  it("carries reserved updater fields through validation without reading them", () => {
    const raw = JSON.stringify({
      tugra: {
        stable: {
          version: "0.3.0",
          hubImage: "h",
          webImage: "w",
          agentSha256: { amd64: "deadbeef" },
          minUpgradeFrom: "0.1.0",
          publishedAt: "2026-07-17T00:00:00Z",
        },
      },
    });
    const out = verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64);
    expect(out.tugra.stable.minUpgradeFrom).toBe("0.1.0");
    expect(out.tugra.stable.agentSha256).toEqual({ amd64: "deadbeef" });
  });
});

describe("notice (signed operator banner)", () => {
  const withNotice = (notice: unknown) => JSON.stringify({ tugra: { stable: { version: "0.2.0" } }, notice });

  it("accepts a valid https notice and returns it", () => {
    const { priv, pubB64 } = keypair();
    const raw = withNotice({ id: "n1", message: "hello", severity: "warning", url: "https://tugra.io/x" });
    const out = verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64);
    expect(out.notice).toEqual({ id: "n1", message: "hello", severity: "warning", url: "https://tugra.io/x" });
  });

  it("defaults severity to info when the signed notice omits it", () => {
    const { priv, pubB64 } = keypair();
    const raw = withNotice({ id: "n1", message: "hello" });
    expect(verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64).notice?.severity).toBe("info");
  });

  it("rejects a non-https notice url (signed but wrong shape)", () => {
    const { priv, pubB64 } = keypair();
    const raw = withNotice({ id: "n1", message: "x", url: "javascript:alert(1)" });
    expect(() => verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64)).toThrow(UpdateVerifyError);
  });

  it("rejects an over-long message (>500 chars)", () => {
    const { priv, pubB64 } = keypair();
    const raw = withNotice({ id: "n1", message: "x".repeat(501) });
    expect(() => verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64)).toThrow(UpdateVerifyError);
  });

  it("rejects an unknown severity", () => {
    const { priv, pubB64 } = keypair();
    const raw = withNotice({ id: "n1", message: "x", severity: "boom" });
    expect(() => verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64)).toThrow(UpdateVerifyError);
  });

  it("a manifest WITHOUT a notice still verifies (optional field)", () => {
    const { priv, pubB64 } = keypair();
    const raw = manifest();
    expect(verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64).notice).toBeUndefined();
  });
});

describe("verifyUpdateManifest imageDigests (consume-time validation)", () => {
  const { priv, pubB64 } = keypair();
  const HEX = "0123456789abcdef".repeat(4);

  it("accepts a signed manifest carrying imageDigests", () => {
    const raw = manifest({ imageDigests: { hub: HEX, web: HEX, updater: HEX, agent: HEX } });
    const out = verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64);
    expect(out.tugra.stable.imageDigests).toEqual({ hub: HEX, web: HEX, updater: HEX, agent: HEX });
  });

  it("still accepts an old manifest with no imageDigests", () => {
    const raw = manifest();
    expect(verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64).tugra.stable.imageDigests).toBeUndefined();
  });

  it("rejects (even when correctly signed) a malformed digest — never reaches the updater", () => {
    for (const bad of ["sha256:" + HEX, HEX.toUpperCase(), HEX.slice(1), "not-hex"]) {
      const raw = manifest({ imageDigests: { hub: bad } });
      expect(() => verifyUpdateManifest(raw, detachedSig(priv, raw), pubB64)).toThrow(/invalid manifest shape/);
    }
  });
});
