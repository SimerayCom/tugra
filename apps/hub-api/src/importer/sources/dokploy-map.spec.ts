import {
  buildDokployFleet,
  dokployBuildPack,
  dokployEngine,
  dokployGit,
  mapApplication,
  mapCompose,
  mapDatabase,
  mapDomain,
  mapEnvBlob,
  mapMount,
  parseDotenv,
  type DokployApplication,
  type DokployDatabase,
  type DokployFleetInput,
} from "./dokploy-map";

const baseApp = (over: Partial<DokployApplication> = {}): DokployApplication => ({ applicationId: "app-id-1", appName: "web-a1b2c3", name: "web", sourceType: "github", buildType: "nixpacks", ...over });

describe("dokploy-map — build pack + source", () => {
  it("maps buildType → Tugra buildPack (heroku/paketo → herokuish/paketo)", () => {
    expect(dokployBuildPack(baseApp({ buildType: "nixpacks" }))).toEqual({ kind: "git", buildPack: "nixpacks" });
    expect(dokployBuildPack(baseApp({ buildType: "railpack" }))).toEqual({ kind: "git", buildPack: "railpack" });
    expect(dokployBuildPack(baseApp({ buildType: "dockerfile" }))).toEqual({ kind: "git", buildPack: "dockerfile" });
    expect(dokployBuildPack(baseApp({ buildType: "static" }))).toEqual({ kind: "git", buildPack: "static" });
    expect(dokployBuildPack(baseApp({ buildType: "heroku_buildpacks" }))).toEqual({ kind: "git", buildPack: "herokuish" });
    expect(dokployBuildPack(baseApp({ buildType: "paketo_buildpacks" }))).toEqual({ kind: "git", buildPack: "paketo" });
  });
  it("a docker source is an image app regardless of buildType", () => {
    expect(dokployBuildPack(baseApp({ sourceType: "docker", buildType: "nixpacks" }))).toEqual({ kind: "image", buildPack: "image" });
  });
});

describe("dokploy-map — git URL derivation per provider", () => {
  it("github → https clone URL + provider github + branch/subdir/dockerfile", () => {
    expect(dokployGit(baseApp({ sourceType: "github", owner: "acme", repository: "api", branch: "main", buildPath: "/svc", dockerfile: "Dockerfile.prod" }))).toEqual({
      url: "https://github.com/acme/api.git",
      branch: "main",
      baseDirectory: "/svc",
      dockerfilePath: "Dockerfile.prod",
      provider: "github",
    });
  });
  it("gitlab uses the path namespace; bitbucket prefers the slug; raw git passes the custom URL", () => {
    expect(dokployGit(baseApp({ sourceType: "gitlab", gitlabPathNamespace: "grp/sub/proj", gitlabBranch: "dev" }))).toMatchObject({ url: "https://gitlab.com/grp/sub/proj.git", branch: "dev", provider: "gitlab" });
    expect(dokployGit(baseApp({ sourceType: "bitbucket", bitbucketOwner: "team", bitbucketRepository: "Repo", bitbucketRepositorySlug: "repo-slug" }))).toMatchObject({ url: "https://bitbucket.org/team/repo-slug.git", provider: "bitbucket" });
    expect(dokployGit(baseApp({ sourceType: "git", customGitUrl: "git@example.com:o/r.git", customGitBranch: "x" }))).toMatchObject({ url: "git@example.com:o/r.git", branch: "x", provider: "git" });
  });
  it("returns undefined when the git columns are missing", () => {
    expect(dokployGit(baseApp({ sourceType: "github", owner: null, repository: null }))).toBeUndefined();
    expect(dokployGit(baseApp({ sourceType: "drop" }))).toBeUndefined();
  });
  it("strips embedded credentials from a custom git URL (never leak a token into the fleet)", () => {
    const g = dokployGit(baseApp({ sourceType: "git", customGitUrl: "https://oauth2:ghp_SECRETTOKEN@github.com/o/r.git" }));
    expect(g?.url).toBe("https://github.com/o/r.git");
    expect(JSON.stringify(g)).not.toContain("ghp_SECRETTOKEN");
    // an scp-style SSH URL keeps its git@ user (not a secret)
    expect(dokployGit(baseApp({ sourceType: "git", customGitUrl: "git@github.com:o/r.git" }))?.url).toBe("git@github.com:o/r.git");
  });
});

describe("dokploy-map — database engine + credentials", () => {
  it("engine is the table; a redis row with a keydb/dragonfly image sniffs through", () => {
    expect(dokployEngine("postgres")).toBe("POSTGRES");
    expect(dokployEngine("libsql")).toBe("LIBSQL");
    expect(dokployEngine("redis", "redis:7")).toBe("REDIS");
    expect(dokployEngine("redis", "eqalpha/keydb:latest")).toBe("KEYDB");
    expect(dokployEngine("redis", "docker.dragonflydb.io/dragonflydb/dragonfly")).toBe("DRAGONFLY");
  });
  it("maps credentials (redis user defaults to 'default'), version from image, sourceRef = appName = hostInternal, no password", () => {
    const pg = mapDatabase({ appName: "pg-x1", name: "orders", databaseUser: "u", databaseName: "orders", dockerImage: "postgres:16-alpine", externalPort: 5433 } as DokployDatabase, "POSTGRES", "srv-1");
    expect(pg).toMatchObject({ sourceRef: "pg-x1", hostInternal: "pg-x1", engine: "POSTGRES", version: "16", externalPort: 5433, credentials: { username: "u", database: "orders", secretRef: "pg-x1" }, serverRef: "srv-1" });
    const redis = mapDatabase({ appName: "redis-y2", databaseUser: null } as DokployDatabase, "REDIS");
    expect(redis.credentials).toMatchObject({ username: "default", secretRef: "redis-y2" });
    expect(Object.keys(pg.credentials ?? {}).sort()).toEqual(["database", "secretRef", "username"]); // only non-secret identity; no password
  });
});

describe("dokploy-map — domains + mounts", () => {
  it("maps cert type, skips preview + disabled, first is primary", () => {
    expect(mapDomain({ host: "a.com", https: true, port: 8080, certificateType: "letsencrypt" })).toMatchObject({ host: "a.com", https: true, port: 8080, certType: "le-http" });
    expect(mapDomain({ host: "b.com", certificateType: "none" })).toMatchObject({ certType: "none" });
    expect(mapDomain({ host: "p.com", domainType: "preview" })).toBeUndefined();
    expect(mapDomain({ host: "d.com", enabled: false })).toBeUndefined();
    expect(mapDomain({ host: null })).toBeUndefined();
  });
  it("maps mount types; a file mount carries no content, a bind keeps a stable name", () => {
    expect(mapMount({ type: "volume", volumeName: "data-vol", mountPath: "/data" }, "own")).toEqual({ name: "data-vol", mountPath: "/data", type: "named", ownerRef: "own" });
    expect(mapMount({ type: "bind", hostPath: "/srv/x", mountPath: "/x" }, "own")).toEqual({ hostPath: "/srv/x", mountPath: "/x", type: "bind", ownerRef: "own" });
    const file = mapMount({ type: "file", filePath: "app.conf", mountPath: "/etc/app.conf" }, "own");
    expect(file).toEqual({ name: "app.conf", mountPath: "/etc/app.conf", type: "file", ownerRef: "own" });
    expect(JSON.stringify(file)).not.toContain("content");
    expect(mapMount({ type: "volume", mountPath: "" }, "own")).toBeUndefined();
  });
});

describe("dokploy-map — env (keys only, refs classified)", () => {
  it("parses dotenv keys, applies the secret heuristic, classifies ${{...}} / vault / enc refs, drops values", () => {
    const blob = ["PORT=3000", "API_SECRET=s3cr3t", "LINK=${{project.DB_URL}}", "VAULT_V=${{vault.hashicorp.path : TOKEN}}", "OLD=enc:v1:abcd", "# comment", "export NAME=hi"].join("\n");
    const env = mapEnvBlob(blob);
    expect(env.find((e) => e.key === "PORT")).toEqual({ key: "PORT" });
    expect(env.find((e) => e.key === "API_SECRET")).toMatchObject({ secret: true });
    expect(env.find((e) => e.key === "LINK")).toMatchObject({ ref: { type: "shared" } });
    expect(env.find((e) => e.key === "VAULT_V")).toMatchObject({ ref: { type: "vault" } });
    expect(env.find((e) => e.key === "OLD")).toMatchObject({ ref: { type: "encrypted" } });
    expect(env.find((e) => e.key === "NAME")).toEqual({ key: "NAME" });
    expect(JSON.stringify(env)).not.toContain("s3cr3t"); // values never carried
    expect(JSON.stringify(env)).not.toContain("3000");
  });
  it("buildSecrets are build-time AND secret", () => {
    expect(mapEnvBlob("TOKEN=x", { buildTime: true, forceSecret: true })[0]).toMatchObject({ buildTime: true, secret: true });
  });
  it("parseDotenv ignores blanks, comments and malformed lines", () => {
    expect(parseDotenv("\n# c\nK=v\nbad line\n=noKey\n").map((e) => e.key)).toEqual(["K"]);
  });
  it("swallows a multi-line quoted value so a PEM/JSON body never leaks as a bogus key (secret-free)", () => {
    const blob = ['PK="-----BEGIN PRIVATE KEY-----', "MIIEabc123", "zzQQ11==", '-----END PRIVATE KEY-----"', "A=1"].join("\n");
    const entries = parseDotenv(blob);
    expect(entries.map((e) => e.key)).toEqual(["PK", "A"]); // NOT ["PK","zzQQ11","A"]
    expect(entries[0].value).toContain("MIIEabc123"); // the whole value is one entry
    const env = mapEnvBlob(blob);
    expect(env.map((e) => e.key)).toEqual(["PK", "A"]);
    expect(JSON.stringify(env)).not.toContain("MIIEabc123"); // and the value is still dropped in the fleet
  });
});

describe("buildDokployFleet — assembly, links, secret-free", () => {
  const input = (): DokployFleetInput => ({
    servers: [{ serverId: "srv-1", name: "box", ipAddress: "1.2.3.4" }, { serverId: "srv-build", serverType: "build" }],
    apps: [
      {
        detail: baseApp({
          appName: "web-a1b2c3",
          sourceType: "github",
          owner: "acme",
          repository: "web",
          env: "DATABASE_URL=postgresql://u:PWD@pg-x1:5432/orders\nPORT=3000",
          domains: [{ host: "web.example.com", certificateType: "letsencrypt" }],
          mounts: [{ type: "volume", volumeName: "media", mountPath: "/media" }],
        }),
        serverRef: "srv-1",
      },
    ],
    composes: [{ detail: { composeId: "c1", appName: "stack-z9", sourceType: "raw", composeType: "stack", composeFile: "services: {}" }, serverRef: "srv-1" }],
    databases: [{ detail: { appName: "pg-x1", name: "orders", databaseUser: "u", databaseName: "orders", databasePassword: "PWD", dockerImage: "postgres:16" } as DokployDatabase, engineTable: "postgres", serverRef: "srv-1" }],
    sharedEnvBlobs: [{ scope: "project", blob: "SHARED=1\nSHARED_SECRET=zzz" }, { scope: "environment", blob: "ENV_K=2" }],
  });

  it("assembles apps+compose+dbs, drops the build server, keeps sourceRef=appName, and links an app to a DB it references", () => {
    const fleet = buildDokployFleet(input());
    expect(fleet.servers.map((s) => s.ref)).toEqual(["srv-1"]); // build server excluded
    expect(fleet.apps.map((a) => a.sourceRef).sort()).toEqual(["stack-z9", "web-a1b2c3"]);
    expect(fleet.databases[0]).toMatchObject({ sourceRef: "pg-x1", engine: "POSTGRES", hostInternal: "pg-x1" });
    const web = fleet.apps.find((a) => a.sourceRef === "web-a1b2c3")!;
    expect(web.internalHost).toBe("web-a1b2c3");
    expect(web.links).toEqual([{ kind: "database", ref: "pg-x1", envKey: "DATABASE_URL", internalHost: "pg-x1" }]);
    expect(fleet.sharedEnv.map((e) => `${e.scope}:${e.key}`)).toEqual(["project:SHARED", "project:SHARED_SECRET", "environment:ENV_K"]);
    expect(fleet.warnings.some((w) => /stack/i.test(w))).toBe(true);
  });

  it("NEVER carries a secret value anywhere in the serialized fleet", () => {
    const fleet = buildDokployFleet(input());
    const json = JSON.stringify(fleet);
    for (const secret of ["PWD", "zzz", "3000"]) expect(json).not.toContain(secret);
  });

  it("does not over-link on a shared slug prefix (boundary-safe token match)", () => {
    const f = input();
    f.databases = [{ detail: { appName: "db", databaseUser: "u", dockerImage: "postgres:16" } as DokployDatabase, engineTable: "postgres" }];
    f.apps[0].detail.env = "X=postgresql://u:p@db-replica:5432/x"; // "db" must NOT match "db-replica"
    const web = buildDokployFleet(f).apps.find((a) => a.sourceRef === "web-a1b2c3")!;
    expect(web.links ?? []).toEqual([]);
  });
});
