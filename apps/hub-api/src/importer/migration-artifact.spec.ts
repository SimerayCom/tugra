import { mintArtifactUrl, verifyArtifactSig, MIGRATION_DL_TTL_MS, type ArtifactClaim } from "./migration-artifact";

const SECRET = "test-secret-key-0123456789abcdef";
const CLAIM: ArtifactClaim = { opId: "op-1", taskId: "task-abc", sha256: "a".repeat(64) };
const NOW = 1_700_000_000_000;

function parse(url: string): { exp: number; sig: string } {
  const q = new URL(url).searchParams;
  return { exp: Number(q.get("exp")), sig: q.get("sig")! };
}

describe("migration-artifact (HMAC capability URL)", () => {
  it("mints a dl URL under /api/v1 bound to the task, with a ~15-min expiry", () => {
    const { url, exp } = mintArtifactUrl("https://hub.example.com", SECRET, CLAIM, NOW);
    expect(url).toContain("/api/v1/import/migration/dl/task-abc.bin?exp=");
    expect(exp).toBe(Math.floor((NOW + MIGRATION_DL_TTL_MS) / 1000));
    const { exp: pexp, sig } = parse(url);
    expect(verifyArtifactSig(SECRET, CLAIM, pexp, sig, NOW)).toBe(true);
  });

  it("rejects a tampered claim, sig, or secret (no forgery)", () => {
    const { exp, sig } = parse(mintArtifactUrl("https://h", SECRET, CLAIM, NOW).url);
    expect(verifyArtifactSig(SECRET, { ...CLAIM, opId: "op-2" }, exp, sig, NOW)).toBe(false);
    expect(verifyArtifactSig(SECRET, { ...CLAIM, taskId: "other" }, exp, sig, NOW)).toBe(false);
    expect(verifyArtifactSig(SECRET, { ...CLAIM, sha256: "b".repeat(64) }, exp, sig, NOW)).toBe(false);
    expect(verifyArtifactSig(SECRET, CLAIM, exp, sig + "x", NOW)).toBe(false);
    expect(verifyArtifactSig("other-secret-0123456789abcdef", CLAIM, exp, sig, NOW)).toBe(false);
  });

  it("rejects an expired, non-integer, or too-far-future expiry", () => {
    const { exp, sig } = parse(mintArtifactUrl("https://h", SECRET, CLAIM, NOW).url);
    expect(verifyArtifactSig(SECRET, CLAIM, exp, sig, NOW + MIGRATION_DL_TTL_MS + 1000)).toBe(false); // expired
    const far = Math.floor((NOW + MIGRATION_DL_TTL_MS * 10) / 1000);
    expect(verifyArtifactSig(SECRET, CLAIM, far, sig, NOW)).toBe(false); // beyond the max window
    expect(verifyArtifactSig(SECRET, CLAIM, 1.5, sig, NOW)).toBe(false);
  });

  it("a re-upload (new sha) invalidates a URL minted for the old content", () => {
    const { exp, sig } = parse(mintArtifactUrl("https://h", SECRET, CLAIM, NOW).url);
    expect(verifyArtifactSig(SECRET, { ...CLAIM, sha256: "f".repeat(64) }, exp, sig, NOW)).toBe(false);
  });
});
