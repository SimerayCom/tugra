import { createHmac } from "node:crypto";
import {
  generateWebhookSecret,
  generateWebhookToken,
  parseRef,
  refMatchesBranch,
  verifyGithubSignature,
  verifyGitlabToken,
} from "./webhook-verify";

describe("webhook-verify", () => {
  const secret = "s3cr3t-value";
  const body = JSON.stringify({ ref: "refs/heads/main" });

  describe("verifyGithubSignature", () => {
    const sig =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

    it("accepts a valid HMAC-SHA256 signature", () => {
      expect(verifyGithubSignature(secret, body, sig)).toBe(true);
    });

    it("rejects a tampered signature", () => {
      expect(verifyGithubSignature(secret, body, sig.slice(0, -1) + "0")).toBe(
        false,
      );
    });

    it("rejects a signature made with the wrong secret", () => {
      const bad =
        "sha256=" + createHmac("sha256", "other").update(body).digest("hex");
      expect(verifyGithubSignature(secret, body, bad)).toBe(false);
    });

    it("rejects missing or malformed headers", () => {
      expect(verifyGithubSignature(secret, body, undefined)).toBe(false);
      expect(verifyGithubSignature(secret, body, "deadbeef")).toBe(false);
    });
  });

  describe("verifyGitlabToken", () => {
    it("accepts the exact secret", () => {
      expect(verifyGitlabToken(secret, secret)).toBe(true);
    });

    it("rejects a wrong or missing token", () => {
      expect(verifyGitlabToken(secret, "nope")).toBe(false);
      expect(verifyGitlabToken(secret, undefined)).toBe(false);
    });
  });

  describe("parseRef", () => {
    it("returns the ref string", () => {
      expect(parseRef({ ref: "refs/heads/dev" })).toBe("refs/heads/dev");
    });

    it("returns null when absent or non-string", () => {
      expect(parseRef({})).toBeNull();
      expect(parseRef({ ref: 1 })).toBeNull();
      expect(parseRef(null)).toBeNull();
    });
  });

  describe("refMatchesBranch", () => {
    it("matches refs/heads/<branch>", () => {
      expect(refMatchesBranch("refs/heads/main", "main")).toBe(true);
    });

    it("does not match a different branch", () => {
      expect(refMatchesBranch("refs/heads/other", "main")).toBe(false);
    });

    it("does not match a null ref (e.g. a ping event)", () => {
      expect(refMatchesBranch(null, "main")).toBe(false);
    });
  });

  describe("token generation", () => {
    it("produces a prefixed, unique webhook token", () => {
      const a = generateWebhookToken();
      const b = generateWebhookToken();
      expect(a).toMatch(/^tugra_wh_/);
      expect(a).not.toBe(b);
    });

    it("produces a non-empty secret", () => {
      expect(generateWebhookSecret().length).toBeGreaterThan(20);
    });
  });
});
