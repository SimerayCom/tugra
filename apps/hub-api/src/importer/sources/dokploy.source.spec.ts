import { DokploySource, type DokployClient } from "./dokploy.source";

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
