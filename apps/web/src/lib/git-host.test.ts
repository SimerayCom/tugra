import { describe, it, expect } from "vitest";
import { gitUrlHost, isSshGitUrl } from "./git-host";

describe("gitUrlHost", () => {
  it("returns the lower-cased host of an https URL, ignoring credentials and port", () => {
    expect(gitUrlHost("https://GitHub.com/acme/app.git")).toBe("github.com");
    expect(gitUrlHost("https://x-access-token@git.example.com:8443/o/r")).toBe("git.example.com");
  });
  it("is null for ssh forms, empty and unparseable input", () => {
    expect(gitUrlHost("git@github.com:acme/app.git")).toBeNull();
    expect(gitUrlHost("ssh://git@github.com/acme/app.git")).toBeNull();
    expect(gitUrlHost("")).toBeNull();
    expect(gitUrlHost(null)).toBeNull();
    expect(gitUrlHost("not a url")).toBeNull();
  });
  it("isSshGitUrl recognises ssh:// and scp-style", () => {
    expect(isSshGitUrl("git@github.com:a/b.git")).toBe(true);
    expect(isSshGitUrl("ssh://git@host/a/b")).toBe(true);
    expect(isSshGitUrl("https://github.com/a/b")).toBe(false);
  });
});
