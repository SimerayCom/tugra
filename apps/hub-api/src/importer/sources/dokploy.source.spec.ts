import { DokploySource, toForeignGitProvider, type DokployClient } from "./dokploy.source";

/** GitHub App credentials seeded into the fake `github.one` — none may ever surface in discover(). */
const GH_SECRETS = {
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEsentinelPRIVATEKEYbody123\n-----END RSA PRIVATE KEY-----",
  clientSecret: "CLIENTSECRET_sentinel_9f8e",
  webhookSecret: "WEBHOOKSECRET_sentinel_7d6c",
  clientId: "Iv1.sentinelclientid",
};

/** A fake Dokploy client whose GETs resolve from a route map (missing → throws, like a 404). An Error value
 *  in the map is thrown (to simulate a per-endpoint 403). */
const ROUTES: Record<string, unknown> = {
  "/project.all": [
    {
      projectId: "p1",
      name: "proj",
      env: "SHARED=1",
      environments: [
        {
          environmentId: "e1",
          name: "production",
          env: "ENV_K=2",
          applications: [{ applicationId: "app-1" }],
          compose: [],
          postgres: [{ postgresId: "pg-1" }],
          mysql: [],
          mariadb: [],
          mongo: [],
          redis: [],
          libsql: [],
        },
      ],
    },
  ],
  "/application.one?applicationId=app-1": {
    applicationId: "app-1",
    appName: "web-a1b2c3",
    name: "web",
    sourceType: "github",
    buildType: "nixpacks",
    githubId: "gh-1",
    autoDeploy: true,
    watchPaths: ["src/**"],
    memoryLimit: "536870912",
    owner: "acme",
    repository: "web",
    branch: "main",
    env: "DATABASE_URL=postgresql://u:PWD@db-pg1:5432/orders\nPORT=3000\nSHARED_REF=${{project.SHARED}}",
    domains: [{ host: "web.example.com", certificateType: "letsencrypt" }],
    mounts: [],
  },
  "/postgres.one?postgresId=pg-1": {
    postgresId: "pg-1",
    appName: "db-pg1",
    name: "orders",
    databaseUser: "u",
    databaseName: "orders",
    databasePassword: "PWD",
    dockerImage: "postgres:16",
  },
  "/server.all": [{ serverId: "srv-1", name: "box", ipAddress: "1.2.3.4" }],
  "/gitProvider.getAll": [
    { gitProviderId: "gp-1", name: "diesdigital-app", providerType: "github", github: { githubId: "gh-1" } },
    { gitProviderId: "gp-2", name: "a-gitlab", providerType: "gitlab", gitlab: { gitlabId: "gl-1" } },
  ],
  "/github.one?githubId=gh-1": {
    githubId: "gh-1",
    gitProviderId: "gp-1",
    githubAppName: "diesdigital-tugra",
    githubAppId: 4242,
    githubInstallationId: "99001",
    githubClientId: GH_SECRETS.clientId,
    githubClientSecret: GH_SECRETS.clientSecret,
    githubPrivateKey: GH_SECRETS.privateKey,
    githubWebhookSecret: GH_SECRETS.webhookSecret,
  },
};

const makeClient = (over: Record<string, unknown> = {}): { get: jest.Mock } => {
  const table = { ...ROUTES, ...over };
  return {
    get: jest.fn(async (p: string) => {
      if (p in table) {
        const v = table[p];
        if (v instanceof Error) throw v;
        return v;
      }
      throw new Error(`404 ${p}`);
    }),
  };
};
const source = (over?: Record<string, unknown>) => new DokploySource(makeClient(over) as unknown as DokployClient);

describe("DokploySource.verify", () => {
  it("passes when project.all returns an array", async () => {
    expect(await source().verify()).toEqual({ ok: true });
  });
  it("fails with a helpful message when the endpoint errors or is not a Dokploy root", async () => {
    const bad = new DokploySource({ get: jest.fn().mockRejectedValue(new Error("Dokploy API error 401 (check the API key…)")) } as unknown as DokployClient);
    expect((await bad.verify()).ok).toBe(false);
    const html = new DokploySource({ get: jest.fn().mockResolvedValue("<html>") } as unknown as DokployClient);
    expect((await html.verify()).ok).toBe(false);
  });
});

describe("DokploySource.discover", () => {
  it("walks project.all → *.one and maps a secret-free fleet (appName as sourceRef, DB link, shared env)", async () => {
    const fleet = await source().discover();
    expect(fleet.apps.map((a) => a.sourceRef)).toEqual(["web-a1b2c3"]);
    const web = fleet.apps[0];
    expect(web).toMatchObject({ kind: "git", buildPack: "nixpacks", internalHost: "web-a1b2c3", git: { url: "https://github.com/acme/web.git", provider: "github" } });
    expect(web.links).toEqual([{ kind: "database", ref: "db-pg1", envKey: "DATABASE_URL", internalHost: "db-pg1" }]);
    expect(fleet.databases).toEqual([expect.objectContaining({ sourceRef: "db-pg1", engine: "POSTGRES", version: "16", hostInternal: "db-pg1" })]);
    expect(fleet.servers).toEqual([{ ref: "srv-1", name: "box", ip: "1.2.3.4" }]);
    expect(fleet.sharedEnv.map((e) => `${e.scope}:${e.key}`)).toEqual(["project:SHARED", "environment:ENV_K"]);
  });

  it("NEVER carries a secret value (env values / DB password) in the discovered fleet", async () => {
    const json = JSON.stringify(await source().discover());
    for (const secret of ["PWD", "3000"]) expect(json).not.toContain(secret);
    expect(json).toContain("DATABASE_URL"); // the KEY is carried; the value is not
  });

  it("discovers git providers as secret-free identity and links the app to its GitHub App", async () => {
    const fleet = await source().discover();
    expect(fleet.gitProviders).toEqual([
      { ref: "gh-1", kind: "github", appSlug: "diesdigital-tugra", appId: "4242", installationId: "99001", htmlUrl: "https://github.com/apps/diesdigital-tugra", appName: "diesdigital-app" },
    ]);
    expect(fleet.apps[0]).toMatchObject({ gitProviderRef: "gh-1", autoDeploy: true, watchPaths: ["src/**"], limits: { memoryMb: 512 } });
    expect(fleet.warnings.some((w) => /GitHub App that could not be read/.test(w))).toBe(false);
  });

  it("SENTINEL: no GitHub App credential (private key / client secret / webhook secret / client id) ever appears in the discovered fleet", async () => {
    const json = JSON.stringify(await source().discover());
    expect(json).toContain("diesdigital-tugra"); // identity is carried
    for (const secret of [GH_SECRETS.privateKey, "MIIEsentinelPRIVATEKEYbody123", "BEGIN RSA PRIVATE KEY", GH_SECRETS.clientSecret, GH_SECRETS.webhookSecret, GH_SECRETS.clientId]) {
      expect(json).not.toContain(secret);
    }
    // the shape itself has no secret-named key
    for (const p of (await source().discover()).gitProviders ?? []) {
      expect(Object.keys(p).filter((k) => /key|secret|token|password/i.test(k))).toEqual([]);
    }
  });

  it("toForeignGitProvider is a whitelist: a row full of credentials yields identity only", () => {
    const p = toForeignGitProvider("gh-9", { githubAppName: "bad slug!", githubAppId: "1", githubInstallationId: "2", githubPrivateKey: "PK", githubClientSecret: "CS", githubWebhookSecret: "WS", extra: "X" }, null);
    expect(p).toEqual({ ref: "gh-9", kind: "github", appSlug: undefined, appId: "1", installationId: "2", htmlUrl: undefined, appName: undefined });
    expect(JSON.stringify(p)).not.toMatch(/PK|CS|WS|"X"/);
  });

  it("degrades an unreadable gitProvider.getAll / github.one to a warning and keeps the rest of the fleet", async () => {
    const a = await source({ "/gitProvider.getAll": new Error("403") }).discover();
    expect(a.gitProviders).toEqual([]);
    expect(a.warnings.some((w) => /could not read git providers/.test(w))).toBe(true);
    expect(a.apps.length).toBe(1);
    const b = await source({ "/github.one?githubId=gh-1": new Error("500") }).discover();
    expect(b.gitProviders).toEqual([]);
    expect(b.warnings.some((w) => /could not read GitHub App gh-1/.test(w))).toBe(true);
    expect(b.warnings.some((w) => /GitHub App that could not be read/.test(w))).toBe(true); // the app that needs it is flagged
  });

  it("degrades a failed server.all to a warning and still returns the fleet", async () => {
    const fleet = await source({ "/server.all": new Error("403") }).discover();
    expect(fleet.servers).toEqual([]);
    expect(fleet.warnings.some((w) => /could not read servers/i.test(w))).toBe(true);
    expect(fleet.apps.length).toBe(1); // the rest of discover still ran
  });

  it("degrades a failed application.one to a warning (that app is dropped, others survive)", async () => {
    const fleet = await source({ "/application.one?applicationId=app-1": new Error("500") }).discover();
    expect(fleet.apps).toEqual([]);
    expect(fleet.databases.length).toBe(1);
    expect(fleet.warnings.some((w) => /could not read application app-1/i.test(w))).toBe(true);
  });
});

describe("DokploySource.fetchSecrets", () => {
  it("returns plain values server-side and reports ${{…}} references as unresolved (never resolved in S1)", async () => {
    const src = source();
    await src.discover(); // populate the appName→id index
    const { values, unresolved } = await src.fetchSecrets("web-a1b2c3");
    expect(values.PORT).toBe("3000");
    expect(values.DATABASE_URL).toContain("db-pg1");
    expect(values.SHARED_REF).toBeUndefined(); // a reference is not resolved in S1
    expect(unresolved).toEqual([{ key: "SHARED_REF", secret: true, ref: { type: "shared" } }]);
  });

  it('returns the GitHub App credentials ONLY via the namespaced "gitProvider:<id>" ref', async () => {
    const src = source();
    const { values, unresolved } = await src.fetchSecrets("gitProvider:gh-1");
    expect(values).toEqual(GH_SECRETS);
    expect(unresolved).toEqual([]);
    // an unknown / unreadable provider degrades to empty, never throws
    expect((await src.fetchSecrets("gitProvider:nope")).values).toEqual({});
    expect((await source({ "/github.one?githubId=gh-1": new Error("500") }).fetchSecrets("gitProvider:gh-1")).values).toEqual({});
    // and it does not need a prior discover (no index dependency)
    expect(Object.keys((await source().fetchSecrets("gitProvider:gh-1")).values).sort()).toEqual(["clientId", "clientSecret", "privateKey", "webhookSecret"]);
  });

  it("rebuilds the index on a cold call (no prior discover)", async () => {
    const { values } = await source().fetchSecrets("web-a1b2c3");
    expect(values.PORT).toBe("3000");
  });

  it("returns empty for an unknown ref rather than throwing", async () => {
    const src = source();
    await src.discover();
    expect(await src.fetchSecrets("does-not-exist")).toEqual({ values: {}, unresolved: [] });
  });
});
