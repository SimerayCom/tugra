import { buildManifest, GITHUB_LOGIN_RE, hashState, installUrl, isPubliclyReachable, manifestPostUrl, newSetupState, sanitizeAppName } from "./github-manifest";

describe("github manifest helpers", () => {
  it("builds a manifest pre-filled with the per-source webhook URL, redirect and setup pages", () => {
    const m = buildManifest({ name: "Acme Deploy", hubBase: "https://hub.example.com/", webBase: "https://panel.example.com", sourceId: "src-1", anyAccount: false });
    expect(m.hook_attributes).toEqual({ url: "https://hub.example.com/webhooks/github/src-1", active: true });
    expect(m.redirect_url).toBe("https://panel.example.com/sources/github/callback");
    expect(m.setup_url).toBe("https://panel.example.com/sources/github/installed");
    expect(m.public).toBe(false);
    expect(m.default_permissions).toEqual({ contents: "read", metadata: "read", pull_requests: "write", statuses: "write" });
    expect(m.default_events).toEqual(["push", "pull_request"]);
  });

  it("can allow any account to install", () => {
    expect(buildManifest({ name: "x", hubBase: "https://h.example.com", webBase: "https://w.example.com", sourceId: "s", anyAccount: true }).public).toBe(true);
  });

  it("turns the webhook off when the hub is not reachable from GitHub", () => {
    for (const hub of ["http://localhost:3000", "http://127.0.0.1:3000", "http://10.0.0.5", "http://192.168.1.2", "http://172.20.0.3", "http://hub", "http://hub.local", "http://[::1]:3000"]) {
      expect(isPubliclyReachable(hub)).toBe(false);
    }
    for (const hub of ["https://hub.example.com", "http://203.0.113.9:3000", "http://172.32.0.1"]) expect(isPubliclyReachable(hub)).toBe(true);
    expect(buildManifest({ name: "x", hubBase: "http://localhost:3000", webBase: "http://localhost:3001", sourceId: "s", anyAccount: false }).hook_attributes.active).toBe(false);
  });

  it("posts to the user's settings or to an organization, with the state in the query", () => {
    expect(manifestPostUrl(undefined, "a b")).toBe("https://github.com/settings/apps/new?state=a%20b");
    expect(manifestPostUrl("acme-inc", "st")).toBe("https://github.com/organizations/acme-inc/settings/apps/new?state=st");
    expect(installUrl("my-app", "st")).toBe("https://github.com/apps/my-app/installations/new?state=st");
  });

  it("validates organization logins", () => {
    for (const ok of ["acme", "acme-inc", "a", "A1-b2"]) expect(GITHUB_LOGIN_RE.test(ok)).toBe(true);
    for (const bad of ["-acme", "acme-", "ac me", "acme/../x", "", "a".repeat(40), "acme?x=1"]) expect(GITHUB_LOGIN_RE.test(bad)).toBe(false);
  });

  it("keeps App names within GitHub's limits and falls back to a generated one", () => {
    expect(sanitizeAppName("  My <b>App</b>  ", "abc123")).toBe("My bAppb");
    expect(sanitizeAppName("x".repeat(80), "abc123")).toHaveLength(34);
    expect(sanitizeAppName("   ", "abc123")).toBe("Tugra abc123");
    expect(sanitizeAppName(undefined, "abc123")).toBe("Tugra abc123");
  });

  it("state is random, long, and only its hash is derivable", () => {
    const a = newSetupState();
    const b = newSetupState();
    expect(a.state).not.toBe(b.state);
    expect(a.state.length).toBeGreaterThanOrEqual(43);
    expect(a.stateHash).toBe(hashState(a.state));
    expect(a.stateHash).not.toContain(a.state);
  });
});
