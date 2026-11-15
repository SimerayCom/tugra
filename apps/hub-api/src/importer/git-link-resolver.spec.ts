import { GitLinkResolverService, parseRepoUrl, needsGitLink, groupGitLinks, PUBLIC_PROBE_MAX, GIT_LINK_REASON } from "./git-link-resolver.service";
import type { ForeignApp } from "./foreign-fleet";

type Src = { id: string; name: string; provider: string; apiUrl: string | null; installationId: string | null };
const ghSrc = (id: string, name = id, installed = true): Src => ({ id, name, provider: "github", apiUrl: null, installationId: installed ? "111" : null });
const giteaSrc = (id: string, host = "git.example.com"): Src => ({ id, name: id, provider: "gitea", apiUrl: `https://${host}`, installationId: null });

const app = (ref: string, url: string, over: Partial<ForeignApp> = {}): ForeignApp => ({ sourceRef: ref, name: `app-${ref}`, kind: "git", buildPack: "nixpacks", serverRef: "s1", git: { url }, ...over });

function make(sources: Src[], opts: { sets?: Record<string, string[] | Error>; tokenSees?: (id: string, o: string, r: string) => "yes" | "no" | "unknown"; probe?: (url: string) => number | Error } = {}) {
  const prisma = { gitSource: { findMany: jest.fn().mockResolvedValue(sources) } };
  const gitSources = {
    installationRepoSet: jest.fn().mockImplementation(async (id: string) => {
      const v = opts.sets?.[id];
      if (v instanceof Error) throw v;
      return new Set((v ?? []).map((x) => x.toLowerCase()));
    }),
    tokenSourceCanSee: jest.fn().mockImplementation(async (id: string, o: string, r: string) => (opts.tokenSees ? opts.tokenSees(id, o, r) : "no")),
  };
  const fetchMock = jest.fn().mockImplementation(async (url: string) => {
    const v = opts.probe ? opts.probe(url) : 404;
    if (v instanceof Error) throw v;
    return { status: v };
  });
  (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  const svc = new GitLinkResolverService(prisma as never, gitSources as never);
  return { svc, prisma, gitSources, fetchMock };
}
const one = async (svc: GitLinkResolverService, a: ForeignApp) => (await svc.resolve("team-1", [a])).get(a.sourceRef)!;

describe("parseRepoUrl", () => {
  it("parses https, scp, ssh:// and bare owner/repo (github.com), dropping .git, userinfo, port and trailing slash", () => {
    const cases: Array<[string, unknown]> = [
      ["https://github.com/o/r.git", { host: "github.com", owner: "o", name: "r", ssh: false }],
      ["https://github.com/o/r/", { host: "github.com", owner: "o", name: "r", ssh: false }],
      ["https://x-access-token:abc@github.com/o/r", { host: "github.com", owner: "o", name: "r", ssh: false }],
      ["HTTPS://GitHub.com/O/R.git", { host: "github.com", owner: "O", name: "R", ssh: false }],
      ["git@github.com:o/r.git", { host: "github.com", owner: "o", name: "r", ssh: true }],
      ["ssh://git@github.com:22/o/r.git", { host: "github.com", owner: "o", name: "r", ssh: true }],
      ["o/r", { host: "github.com", owner: "o", name: "r", ssh: false }],
      ["https://gitlab.com/group/sub/proj.git", { host: "gitlab.com", owner: "group/sub", name: "proj", ssh: false }],
    ];
    for (const [url, want] of cases) expect(parseRepoUrl(url)).toEqual(want);
  });
  it("rejects what is not a repo URL", () => {
    for (const bad of ["", "   ", "ftp://h/o/r", "https://github.com/onlyowner", "not a url", "https://github.com/o/../r", undefined, null]) expect(parseRepoUrl(bad as never)).toBeNull();
  });
});

describe("needsGitLink", () => {
  it("GIT builds and git-sourced compose only", () => {
    expect(needsGitLink(app("a", "https://github.com/o/r"))).toBe(true);
    expect(needsGitLink(app("b", "https://github.com/o/r", { kind: "compose", buildPack: "dockercompose" }))).toBe(true); // git compose
    expect(needsGitLink(app("c", "https://github.com/o/r", { kind: "compose", buildPack: "dockercompose", composeFile: "services: {}" }))).toBe(false); // stored YAML
    expect(needsGitLink({ ...app("d", ""), git: undefined, kind: "image", buildPack: "image", image: "nginx" })).toBe(false);
  });
});

describe("GitLinkResolverService.resolve", () => {
  it("linked: exactly one installation sees the repo (case-insensitive), https, row carries source id+name, itemRef is the namespaced task ref", async () => {
    const { svc } = make([ghSrc("g1", "Acme App")], { sets: { g1: ["Acme/Web"] } });
    const row = await one(svc, app("a1", "https://github.com/acme/web.git"));
    expect(row).toMatchObject({ itemRef: "app:s1:a1", name: "app-a1", status: "linked", sourceId: "g1", sourceName: "Acme App", repo: { host: "github.com", owner: "acme", name: "web" } });
    expect(row.rewriteUrl).toBeUndefined();
    expect(row.reason).toBe(GIT_LINK_REASON.linked);
  });

  it("bare o/r (how Coolify stores a GitHub-App repo) is github.com", async () => {
    const { svc } = make([ghSrc("g1")], { sets: { g1: ["o/r"] } });
    expect(await one(svc, app("a", "o/r"))).toMatchObject({ status: "linked", sourceId: "g1" });
  });

  it("an https github repo with provider UNSET is resolved by host (the old provider gate never linked these)", async () => {
    const { svc } = make([ghSrc("g1")], { sets: { g1: ["o/r"] } });
    expect(await one(svc, app("a", "https://github.com/o/r.git", { git: { url: "https://github.com/o/r.git", provider: undefined } }))).toMatchObject({ status: "linked" });
  });

  it("a repo the installation cannot see is NEVER linked to it (unrelated-App regression): public probe says 404 => needs_source", async () => {
    const { svc } = make([ghSrc("g1")], { sets: { g1: ["other/repo"] }, probe: () => 404 });
    const row = await one(svc, app("a", "https://github.com/o/r.git"));
    expect(row.status).toBe("needs_source");
    expect(row.sourceId).toBeUndefined();
  });

  it("two or more sources see it => ambiguous with candidates, never guessed", async () => {
    const { svc } = make([ghSrc("g1", "One"), ghSrc("g2", "Two")], { sets: { g1: ["o/r"], g2: ["o/r"] } });
    const row = await one(svc, app("a", "https://github.com/o/r.git"));
    expect(row.status).toBe("ambiguous");
    expect(row.candidates).toEqual([{ id: "g1", name: "One" }, { id: "g2", name: "Two" }]);
    expect(row.sourceId).toBeUndefined();
  });

  it("an un-installed GitHub source is not a candidate", async () => {
    const { svc, gitSources } = make([ghSrc("g1", "x", false)], { probe: () => 404 });
    await one(svc, app("a", "https://github.com/o/r.git"));
    expect(gitSources.installationRepoSet).not.toHaveBeenCalled();
  });

  it("pagination is delegated per source and cached per call (one listing for many apps)", async () => {
    const { svc, gitSources } = make([ghSrc("g1")], { sets: { g1: ["o/a", "o/b", "o/c"] } });
    const rows = await svc.resolve("t", [app("1", "https://github.com/o/a"), app("2", "https://github.com/o/b"), app("3", "https://github.com/o/c")]);
    expect([...rows.values()].map((r) => r.status)).toEqual(["linked", "linked", "linked"]);
    expect(gitSources.installationRepoSet).toHaveBeenCalledTimes(1);
  });

  describe("public probe (unauthenticated, only for uncovered github.com https repos)", () => {
    it("200 => public_ok; 404 => needs_source (private); 403/429/network => unknown (may be our rate limit, not proven)", async () => {
      const status: Record<string, number | Error> = { "https://api.github.com/repos/o/ok": 200, "https://api.github.com/repos/o/limited": 429, "https://api.github.com/repos/o/forbid": 403, "https://api.github.com/repos/o/boom": new Error("net") };
      const { svc, fetchMock } = make([], { probe: (u) => status[u] ?? 404 });
      const rows = await svc.resolve("t", ["ok", "limited", "forbid", "boom", "priv"].map((n) => app(n, `https://github.com/o/${n}`)));
      expect(Object.fromEntries([...rows].map(([k, r]) => [k, r.status]))).toEqual({ ok: "public_ok", limited: "unknown", forbid: "unknown", boom: "unknown", priv: "needs_source" });
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization"); // unauthenticated
    });

    it("ONE request per DISTINCT repo even when many apps share it", async () => {
      const { svc, fetchMock } = make([], { probe: () => 200 });
      await svc.resolve("t", [app("1", "https://github.com/o/r"), app("2", "o/r"), app("3", "https://github.com/O/R.git")]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it(`skipped (needs_source, zero requests) when more than ${PUBLIC_PROBE_MAX} distinct repos are uncovered`, async () => {
      const { svc, fetchMock } = make([]);
      const apps = Array.from({ length: PUBLIC_PROBE_MAX + 1 }, (_, i) => app(`a${i}`, `https://github.com/o/r${i}`));
      const rows = await svc.resolve("t", apps);
      expect([...rows.values()].every((r) => r.status === "needs_source")).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("runs with bounded concurrency (4)", async () => {
      let inflight = 0;
      let peak = 0;
      const { svc } = make([]);
      (global as unknown as { fetch: unknown }).fetch = jest.fn().mockImplementation(async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 3));
        inflight--;
        return { status: 200 };
      });
      await svc.resolve("t", Array.from({ length: 20 }, (_, i) => app(`a${i}`, `https://github.com/o/r${i}`)));
      expect(peak).toBeLessThanOrEqual(4);
    });
  });

  describe("ssh URLs", () => {
    it("covered by an installation => linked + rewriteUrl to https (D5, default on)", async () => {
      const { svc } = make([ghSrc("g1")], { sets: { g1: ["o/r"] } });
      const row = await one(svc, app("a", "git@github.com:o/r.git"));
      expect(row).toMatchObject({ status: "linked", sourceId: "g1", rewriteUrl: "https://github.com/o/r.git" });
    });
    it("ssh:// form is rewritten the same way", async () => {
      const { svc } = make([ghSrc("g1")], { sets: { g1: ["o/r"] } });
      expect(await one(svc, app("a", "ssh://git@github.com/o/r.git"))).toMatchObject({ status: "linked", rewriteUrl: "https://github.com/o/r.git" });
    });
    it("not covered => ssh_deploy_key, URL kept (no public probe: ssh implies private)", async () => {
      const { svc, fetchMock } = make([ghSrc("g1")], { sets: { g1: [] } });
      const row = await one(svc, app("a", "git@github.com:o/r.git"));
      expect(row.status).toBe("ssh_deploy_key");
      expect(row.rewriteUrl).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("other hosts", () => {
    it("gitlab / bitbucket => unsupported_host with the honest text, never linked, never probed", async () => {
      const { svc, fetchMock } = make([ghSrc("g1")], { sets: { g1: ["o/r"] } });
      for (const url of ["https://gitlab.com/o/r.git", "git@bitbucket.org:o/r.git"]) {
        const row = await one(svc, app("a", url));
        expect(row.status).toBe("unsupported_host");
        expect(row.reason).toMatch(/GitLab\/Bitbucket sources are not supported yet/);
        expect(row.sourceId).toBeUndefined();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("a Gitea-family source whose apiUrl host equals the repo host and sees it => linked", async () => {
      const { svc, gitSources } = make([giteaSrc("t1")], { tokenSees: () => "yes" });
      const row = await one(svc, app("a", "https://git.example.com/o/r.git"));
      expect(row).toMatchObject({ status: "linked", sourceId: "t1" });
      expect(gitSources.tokenSourceCanSee).toHaveBeenCalledWith("t1", "o", "r");
    });
    it("Gitea source that cannot see it => needs_source; probe error => unknown; a different host stays unsupported", async () => {
      expect((await one(make([giteaSrc("t1")], { tokenSees: () => "no" }).svc, app("a", "https://git.example.com/o/r.git"))).status).toBe("needs_source");
      expect((await one(make([giteaSrc("t1")], { tokenSees: () => "unknown" }).svc, app("a", "https://git.example.com/o/r.git"))).status).toBe("unknown");
      expect((await one(make([giteaSrc("t1")], { tokenSees: () => "yes" }).svc, app("a", "https://other.example.com/o/r.git"))).status).toBe("unsupported_host");
    });
    it("a github-only source never covers a gitea host and vice versa (host-keyed)", async () => {
      const { svc, gitSources } = make([ghSrc("g1")], { sets: { g1: ["o/r"] } });
      expect((await one(svc, app("a", "https://git.example.com/o/r.git"))).status).toBe("unsupported_host");
      expect(gitSources.installationRepoSet).not.toHaveBeenCalled();
    });
  });

  describe("failure handling (never a heuristic fallback)", () => {
    it("an installation listing that throws => unknown, even though it is the only installed source", async () => {
      const { svc } = make([ghSrc("g1")], { sets: { g1: new Error("HTTP 500") }, probe: () => 200 });
      const row = await one(svc, app("a", "https://github.com/o/r.git"));
      expect(row.status).toBe("unknown");
      expect(row.sourceId).toBeUndefined();
    });
    it("one source failing does not stop another that proves visibility", async () => {
      const { svc } = make([ghSrc("g1"), ghSrc("g2")], { sets: { g1: new Error("x"), g2: ["o/r"] } });
      expect(await one(svc, app("a", "https://github.com/o/r.git"))).toMatchObject({ status: "linked", sourceId: "g2" });
    });
    it("failing to list the team's sources => every app unknown", async () => {
      const { svc, prisma } = make([]);
      prisma.gitSource.findMany.mockRejectedValue(new Error("db"));
      expect((await one(svc, app("a", "https://github.com/o/r.git"))).status).toBe("unknown");
    });
    it("an unparsable URL => unknown with a null repo", async () => {
      const { svc } = make([ghSrc("g1")]);
      expect(await one(svc, app("a", "nonsense"))).toMatchObject({ status: "unknown", repo: null });
    });
  });

  it("the carried-source branch is untouched: apps with a gitProviderRef are skipped entirely; non-git apps too", async () => {
    const { svc, prisma } = make([ghSrc("g1")], { sets: { g1: ["o/r"] } });
    const rows = await svc.resolve("t", [app("a", "https://github.com/o/r.git", { gitProviderRef: "gh-1" }), { ...app("b", ""), git: undefined, kind: "image", buildPack: "image", image: "nginx" }]);
    expect(rows.size).toBe(0);
    expect(prisma.gitSource.findMany).not.toHaveBeenCalled();
  });

  it("scopes the sources query to the target team", async () => {
    const { svc, prisma } = make([ghSrc("g1")], { sets: { g1: ["o/r"] } });
    await svc.resolve("team-77", [app("a", "o/r")]);
    expect(prisma.gitSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: "team-77" } }));
  });

  it("never exposes a credential: rows carry ids/names/fixed text only", async () => {
    const { svc } = make([ghSrc("g1", "Acme")], { sets: { g1: ["o/r"] } });
    const row = await one(svc, app("a", "https://x-access-token:ghp_SECRET@github.com/o/r.git"));
    expect(JSON.stringify(row)).not.toContain("ghp_SECRET");
  });
});

describe("groupGitLinks", () => {
  it("collapses N apps under one owner/status into one group (74 apps => 1-3 groups)", () => {
    const mk = (i: number, owner: string, status: "linked" | "needs_source"): never =>
      ({ itemRef: `app:s:${i}`, name: `n${i}`, repo: { host: "github.com", owner, name: `r${i}` }, status, reason: "", ...(status === "linked" ? { sourceName: "Acme" } : {}) }) as never;
    const rows = [...Array.from({ length: 60 }, (_, i) => mk(i, "acme", "linked")), ...Array.from({ length: 14 }, (_, i) => mk(100 + i, "acme", "needs_source"))];
    const g = groupGitLinks(rows);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.status === "linked")).toMatchObject({ host: "github.com", owner: "acme", apps: 60, sourceName: "Acme" });
    expect(g.find((x) => x.status === "needs_source")!.apps).toBe(14);
  });
});
