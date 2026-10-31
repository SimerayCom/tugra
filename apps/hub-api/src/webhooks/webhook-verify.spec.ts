import { createHmac } from "node:crypto";
import {
  generateWebhookSecret,
  generateWebhookToken,
  hasSkipMarker,
  parseHeadCommitMessage,
  parsePullRequest,
  parseRef,
  refMatchesBranch,
  repoFullName,
  verifyGithubSignature,
  verifyGitlabToken,
  verifyGiteaSignature,
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

  describe("verifyGiteaSignature", () => {
    // Gitea/Forgejo: same HMAC-SHA256 digest as GitHub but hex, no `sha256=` prefix.
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    it("accepts a valid hex HMAC and rejects tampered/wrong-secret/missing", () => {
      expect(verifyGiteaSignature(secret, body, sig)).toBe(true);
      expect(verifyGiteaSignature(secret, body, sig.slice(0, -1) + "0")).toBe(false);
      expect(verifyGiteaSignature(secret, body, createHmac("sha256", "other").update(body).digest("hex"))).toBe(false);
      expect(verifyGiteaSignature(secret, body, undefined)).toBe(false);
      expect(verifyGiteaSignature(secret, body, `sha256=${sig}`)).toBe(false); // prefix is NOT accepted here
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

  describe("parsePullRequest", () => {
    it("parses an opened PR event (number + head ref)", () => {
      const ev = parsePullRequest({
        action: "opened",
        pull_request: { number: 42, head: { ref: "feature-x" } },
      });
      expect(ev).toEqual({
        action: "opened",
        prNumber: 42,
        headRef: "feature-x",
        merged: false,
      });
    });

    it("flags a merged close event", () => {
      const ev = parsePullRequest({
        action: "closed",
        pull_request: { number: 7, merged: true, head: { ref: "fix" } },
      });
      expect(ev?.action).toBe("closed");
      expect(ev?.merged).toBe(true);
    });

    it("returns null for non-PR or incomplete payloads", () => {
      expect(parsePullRequest({ ref: "refs/heads/main" })).toBeNull();
      expect(parsePullRequest({ action: "opened" })).toBeNull();
      expect(parsePullRequest({ action: "opened", pull_request: { number: 1 } })).toBeNull();
      expect(parsePullRequest(null)).toBeNull();
    });
  });

  describe("parseHeadCommitMessage", () => {
    it("reads GitHub head_commit.message", () => {
      expect(parseHeadCommitMessage({ head_commit: { message: "fix bug" } })).toBe("fix bug");
    });
    it("reads the last GitLab commit message", () => {
      expect(
        parseHeadCommitMessage({ commits: [{ message: "a" }, { message: "head" }] }),
      ).toBe("head");
    });
    it("returns null when no message present", () => {
      expect(parseHeadCommitMessage({ ref: "refs/heads/main" })).toBeNull();
      expect(parseHeadCommitMessage(null)).toBeNull();
    });
  });

  describe("hasSkipMarker", () => {
    it("detects the standard skip markers (case-insensitive)", () => {
      for (const m of ["[skip ci]", "[ci skip]", "[SKIP CD]", "[cd skip]", "[skip deploy]", "[no deploy]"]) {
        expect(hasSkipMarker(`chore: release ${m}`)).toBe(true);
      }
    });
    it("ignores normal messages and empty input", () => {
      expect(hasSkipMarker("feat: add skipping logic")).toBe(false);
      expect(hasSkipMarker(null)).toBe(false);
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

  describe("repoFullName", () => {
    it("extracts owner/repo from https, scheme-with-token, ssh and bare forms", () => {
      expect(repoFullName("https://github.com/acme/app.git")).toBe("acme/app");
      expect(repoFullName("https://github.com/acme/app")).toBe("acme/app");
      expect(repoFullName("https://github.com/Acme/App/")).toBe("acme/app");
      expect(repoFullName("https://x-access-token@github.com/acme/app.git")).toBe("acme/app");
      expect(repoFullName("git@github.com:acme/app.git")).toBe("acme/app");
      expect(repoFullName("acme/app")).toBe("acme/app");
      expect(repoFullName(null)).toBeNull();
      expect(repoFullName("")).toBeNull();
      expect(repoFullName("https://github.com/acme")).toBeNull();
    });

    it("matches EXACTLY — the old substring bug (acme/app vs acme/app-2) is gone", () => {
      const push = "acme/app";
      // the buggy substring check matched all of these; exact match accepts only the first
      expect(repoFullName("https://github.com/acme/app.git") === push).toBe(true);
      expect(repoFullName("https://github.com/acme/app-2.git") === push).toBe(false);
      expect(repoFullName("https://github.com/acme/application.git") === push).toBe(false);
      expect(repoFullName("https://github.com/evil/acme-app.git") === push).toBe(false);
    });
  });
});
