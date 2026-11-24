import { describe, it, expect, afterEach } from "vitest";
import { filterRepos, isGithubInstallUrl, isGithubLogin, isGithubPostUrl, isPubliclyReachable, looksLikePrivateKey, postManifestToGithub } from "./github-manifest";

describe("github manifest helpers", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("only ever posts the manifest to GitHub's own app-creation pages", () => {
    expect(isGithubPostUrl("https://github.com/settings/apps/new?state=x")).toBe(true);
    expect(isGithubPostUrl("https://github.com/organizations/acme-inc/settings/apps/new?state=x")).toBe(true);
    for (const bad of ["http://github.com/settings/apps/new", "https://evil.example.com/settings/apps/new", "https://github.com.evil.example.com/settings/apps/new", "https://github.com/login", "javascript:alert(1)", "nope"]) {
      expect(isGithubPostUrl(bad)).toBe(false);
    }
  });

  it("only follows GitHub's install page after the App is created", () => {
    expect(isGithubInstallUrl("https://github.com/apps/my-app/installations/new?state=x")).toBe(true);
    expect(isGithubInstallUrl("https://evil.example.com/apps/my-app/installations/new")).toBe(false);
    expect(isGithubInstallUrl("https://github.com/apps/my-app")).toBe(false);
  });

  it("submits a real form POST carrying the manifest JSON", () => {
    const submit = HTMLFormElement.prototype.submit;
    let captured: { action: string; method: string; manifest: string } | null = null;
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      captured = { action: this.action, method: this.method, manifest: (this.elements.namedItem("manifest") as HTMLInputElement).value };
    };
    try {
      postManifestToGithub("https://github.com/settings/apps/new?state=abc", { name: "Acme", public: false });
    } finally {
      HTMLFormElement.prototype.submit = submit;
    }
    expect(captured).toEqual({ action: "https://github.com/settings/apps/new?state=abc", method: "post", manifest: JSON.stringify({ name: "Acme", public: false }) });
    expect(() => postManifestToGithub("https://evil.example.com/x", {})).toThrow();
  });

  it("recognises a PEM private key and rejects other files", () => {
    expect(looksLikePrivateKey("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n")).toBe(true);
    expect(looksLikePrivateKey("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe(true);
    expect(looksLikePrivateKey("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----")).toBe(false);
    expect(looksLikePrivateKey("hello")).toBe(false);
  });

  it("validates organization names and filters repositories case-insensitively", () => {
    expect(isGithubLogin("acme-inc")).toBe(true);
    expect(isGithubLogin("-acme")).toBe(false);
    expect(isGithubLogin("ac me")).toBe(false);
    const repos = [{ fullName: "Acme/Web" }, { fullName: "acme/api" }, { fullName: "other/tool" }];
    expect(filterRepos(repos, " WEB ")).toEqual([{ fullName: "Acme/Web" }]);
    expect(filterRepos(repos, "")).toHaveLength(3);
  });

  it("flags webhook URLs GitHub cannot reach", () => {
    expect(isPubliclyReachable("https://hub.example.com/webhooks/github/x")).toBe(true);
    expect(isPubliclyReachable("http://localhost:3000/webhooks/github/x")).toBe(false);
    expect(isPubliclyReachable("http://192.168.1.4/webhooks/github/x")).toBe(false);
  });
});
