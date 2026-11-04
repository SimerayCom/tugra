import { describe, it, expect } from "vitest";
import { gitWebUrls } from "./git-web-url";

describe("gitWebUrls", () => {
  it("derives the repo URL from an https clone url (strips .git)", () => {
    expect(gitWebUrls("https://github.com/acme/app.git").repo).toBe("https://github.com/acme/app");
    expect(gitWebUrls("https://gitlab.com/g/sub/app").repo).toBe("https://gitlab.com/g/sub/app");
  });

  it("strips an embedded credential and the port from the host", () => {
    expect(gitWebUrls("https://x-access-token@github.com/acme/app.git").repo).toBe("https://github.com/acme/app");
    expect(gitWebUrls("https://git.example.com:8443/acme/app.git").repo).toBe("https://git.example.com/acme/app");
  });

  it("converts scp-style and ssh:// urls to https", () => {
    expect(gitWebUrls("git@github.com:acme/app.git").repo).toBe("https://github.com/acme/app");
    expect(gitWebUrls("ssh://git@gitea.example.org:2222/acme/app.git").repo).toBe("https://gitea.example.org/acme/app");
  });

  it("adds a /commit/<sha> link only for a valid SHA", () => {
    expect(gitWebUrls("https://github.com/acme/app.git", "a1b2c3d").commit).toBe("https://github.com/acme/app/commit/a1b2c3d");
    expect(gitWebUrls("https://github.com/acme/app.git", null).commit).toBeNull();
    expect(gitWebUrls("https://github.com/acme/app.git", "not-a-sha").commit).toBeNull();
  });

  it("returns null for empty, non-git, or injection-y input (never a non-https href)", () => {
    expect(gitWebUrls("").repo).toBeNull();
    expect(gitWebUrls(null).repo).toBeNull();
    expect(gitWebUrls("javascript:alert(1)").repo).toBeNull();
    expect(gitWebUrls("not a url").repo).toBeNull();
    expect(gitWebUrls("https://localhost/x").repo).toBeNull(); // no dotted host → rejected
  });
});
