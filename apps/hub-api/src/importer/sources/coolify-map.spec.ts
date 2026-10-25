import {
  mapCoolifyBuildPack,
  coolifyEngine,
  parseFqdns,
  parsePorts,
  versionFromImage,
  mapApplication,
  mapDatabase,
  buildCoolifyFleet,
  normalizeGitUrl,
  type CoolifyFleetInput,
} from "./coolify-map";

describe("normalizeGitUrl", () => {
  it("normalizes a bare owner/repo (Coolify GitHub-App form) to a clone URL", () => {
    expect(normalizeGitUrl("o/r")).toBe("https://github.com/o/r.git");
    expect(normalizeGitUrl("acme/my-app.git")).toBe("https://github.com/acme/my-app.git"); // no double .git
    expect(normalizeGitUrl("  acme/my-app  ")).toBe("https://github.com/acme/my-app.git"); // trimmed
  });
  it("passes real URLs / scp forms through unchanged", () => {
    expect(normalizeGitUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(normalizeGitUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(normalizeGitUrl("ssh://git@host/o/r.git")).toBe("ssh://git@host/o/r.git");
  });
  it("leaves an unrecognized form as-is (planner flags it, no silent rewrite)", () => {
    expect(normalizeGitUrl("some-weird-value")).toBe("some-weird-value");
  });
  it("the normalized owner/repo URL satisfies CreateAppSchema's gitUrl regex", () => {
    expect(/^(https:\/\/|git@|ssh:\/\/)/.test(normalizeGitUrl("o/r"))).toBe(true);
  });
});

describe("mapCoolifyBuildPack", () => {
  it("maps each Coolify build pack to a Tugra kind + build pack", () => {
    expect(mapCoolifyBuildPack({ uuid: "a", build_pack: "nixpacks", git_repository: "o/r" })).toEqual({ kind: "git", buildPack: "nixpacks" });
    expect(mapCoolifyBuildPack({ uuid: "a", build_pack: "dockerfile", git_repository: "o/r" })).toEqual({ kind: "git", buildPack: "dockerfile" });
    expect(mapCoolifyBuildPack({ uuid: "a", build_pack: "static", git_repository: "o/r" })).toEqual({ kind: "git", buildPack: "static" });
    expect(mapCoolifyBuildPack({ uuid: "a", build_pack: "dockercompose" })).toEqual({ kind: "compose", buildPack: "dockercompose" });
  });
  it("treats a registry-image app (no git repo) as an IMAGE app first", () => {
    expect(mapCoolifyBuildPack({ uuid: "a", build_pack: "dockerfile", docker_registry_image_name: "nginx" })).toEqual({ kind: "image", buildPack: "image" });
  });
  it("detects build_pack 'dockerimage' even with Coolify's placeholder git repo", () => {
    expect(
      mapCoolifyBuildPack({ uuid: "a", build_pack: "dockerimage", git_repository: "coollabsio/coolify", git_branch: "main", docker_registry_image_name: "redis" }),
    ).toEqual({ kind: "image", buildPack: "image" });
  });
  it("falls back to git/unknown for an unrecognised build pack", () => {
    expect(mapCoolifyBuildPack({ uuid: "a", build_pack: "weird", git_repository: "o/r" })).toEqual({ kind: "git", buildPack: "unknown" });
  });
});

describe("coolifyEngine", () => {
  it("maps the database_type discriminator", () => {
    expect(coolifyEngine({ uuid: "d", database_type: "standalone-postgresql" })).toBe("POSTGRES");
    expect(coolifyEngine({ uuid: "d", database_type: "standalone-clickhouse" })).toBe("CLICKHOUSE");
  });
  it("treats SQLite as UNKNOWN (no Tugra equivalent)", () => {
    expect(coolifyEngine({ uuid: "d", database_type: "standalone-sqlite" })).toBe("UNKNOWN");
  });
  it("falls back to the image when database_type is missing (Coolify's KeyDB bug)", () => {
    expect(coolifyEngine({ uuid: "d", image: "eqalpha/keydb:latest" })).toBe("KEYDB");
    expect(coolifyEngine({ uuid: "d", image: "docker.dragonflydb.io/dragonflydb/dragonfly" })).toBe("DRAGONFLY");
    expect(coolifyEngine({ uuid: "d" })).toBe("UNKNOWN");
  });
});

describe("parsers", () => {
  it("parseFqdns splits comma-separated URLs with scheme; first is primary; keeps a path", () => {
    expect(parseFqdns("https://a.com,http://b.com:3000")).toEqual([
      { host: "a.com", https: true, port: undefined, path: undefined, primary: true },
      { host: "b.com", https: false, port: 3000, path: undefined, primary: false },
    ]);
    expect(parseFqdns("https://a.com/api")).toEqual([{ host: "a.com", https: true, port: undefined, path: "/api", primary: true }]);
    expect(parseFqdns(null)).toEqual([]);
  });
  it("parseFqdns collapses an http+https pair for the SAME host into ONE domain (https wins, either order)", () => {
    // Coolify lists both schemes of one domain; that must not count as two.
    expect(parseFqdns("https://x.com,http://x.com")).toEqual([{ host: "x.com", https: true, port: undefined, path: undefined, primary: true }]);
    expect(parseFqdns("http://x.com,https://x.com")).toEqual([{ host: "x.com", https: true, port: undefined, path: undefined, primary: true }]);
    // different host, or same host with a different path/port, stay distinct
    expect(parseFqdns("https://x.com,https://x.com/admin").length).toBe(2);
  });
  it("parsePorts keeps positive integers only", () => {
    expect(parsePorts("3000,8080")).toEqual([3000, 8080]);
    expect(parsePorts("")).toEqual([]);
  });
  it("versionFromImage extracts the tag version, robust to registry host:port and digests", () => {
    expect(versionFromImage("postgres:17-alpine")).toBe("17");
    expect(versionFromImage("redis:7.2")).toBe("7.2");
    expect(versionFromImage("registry.example.com:5000/postgres:16")).toBe("16"); // not the registry port
    expect(versionFromImage("repo@sha256:abcdef")).toBeUndefined(); // digest-pinned
    expect(versionFromImage("mongo")).toBeUndefined();
  });
});

describe("mapApplication", () => {
  it("maps a git app with domains, ports, env KEYS (no values) and volumes", () => {
    const app = mapApplication(
      {
        uuid: "app-1",
        name: "web",
        build_pack: "nixpacks",
        git_repository: "o/r",
        git_branch: "main",
        ports_exposes: "3000",
        fqdn: "https://web.example.com",
      },
      {
        envs: [{ key: "SECRET_KEY", is_buildtime: false }, { key: "SERVICE_FQDN_WEB", is_coolify: true }],
        volumes: [{ name: "web-data", mount_path: "/data", host_path: null }],
        serverRef: "srv-a",
      },
    );
    expect(app).toMatchObject({
      sourceRef: "app-1",
      name: "web",
      kind: "git",
      buildPack: "nixpacks",
      imageOrigin: "built-from-git",
      git: { url: "https://github.com/o/r.git", branch: "main" }, // owner/repo (GitHub App) normalized to a clone URL

      ports: [3000],
      serverRef: "srv-a",
      internalHost: "app-1",
    });
    expect(app.domains).toEqual([{ host: "web.example.com", https: true, port: undefined, primary: true }]);
    expect(app.env).toEqual([
      { key: "SECRET_KEY", buildTime: false, generated: undefined, ref: undefined },
      { key: "SERVICE_FQDN_WEB", buildTime: undefined, generated: true, ref: { type: "magic" } },
    ]);
    expect(app.volumes).toEqual([{ name: "web-data", hostPath: undefined, mountPath: "/data", type: "named", ownerRef: "app-1" }]);
  });
});

describe("mapApplication (docker-image app)", () => {
  it("maps a dockerimage app to kind image with the image ref and no bogus git", () => {
    const app = mapApplication(
      { uuid: "app-2", name: "cache", build_pack: "dockerimage", git_repository: "coollabsio/coolify", git_branch: "main", docker_registry_image_name: "redis", docker_registry_image_tag: "7" },
      { envs: [], volumes: [], serverRef: "srv-a" },
    );
    expect(app).toMatchObject({ kind: "image", buildPack: "image", image: "redis:7", imageOrigin: "registry" });
    expect(app.git).toBeUndefined();
    expect(app.publishDirectory).toBeUndefined();
  });
});

describe("mapDatabase", () => {
  it("maps a postgres DB with non-secret identity + secretRef, never a password", () => {
    const db = mapDatabase(
      { uuid: "db-1", name: "orders", database_type: "standalone-postgresql", image: "postgres:16", postgres_user: "u", postgres_db: "orders", is_public: true, public_port: 5433 },
      { volumes: [], serverRef: "srv-a" },
    );
    expect(db).toMatchObject({
      sourceRef: "db-1",
      name: "orders",
      engine: "POSTGRES",
      version: "16",
      image: "postgres:16",
      credentials: { username: "u", database: "orders", secretRef: "db-1" },
      hostInternal: "db-1",
      externalPort: 5433,
      serverRef: "srv-a",
    });
  });
});

describe("buildCoolifyFleet", () => {
  const input: CoolifyFleetInput = {
    servers: [{ uuid: "srv-a", name: "box", ip: "1.2.3.4" }],
    resourcesByServer: { "srv-a": ["app-1", "db-1"] },
    apps: [{ uuid: "app-1", name: "web", build_pack: "nixpacks", git_repository: "o/r", ports_exposes: "3000" }],
    databases: [
      { uuid: "db-1", name: "orders", database_type: "standalone-postgresql", image: "postgres:16", postgres_user: "u", postgres_db: "orders" },
      { uuid: "db-2", name: "lite", database_type: "standalone-sqlite" },
    ],
    services: [{ uuid: "svc-1", name: "stack", service_type: "plausible" }], // no composeFile (read:sensitive)
    envsByResource: { "app-1": [{ key: "K" }] },
    volumesByResource: {},
  };
  const fleet = buildCoolifyFleet(input);

  it("assembles servers/apps/databases/services with server placement derived", () => {
    expect(fleet.servers).toEqual([{ ref: "srv-a", name: "box", ip: "1.2.3.4" }]);
    expect(fleet.apps[0]).toMatchObject({ sourceRef: "app-1", serverRef: "srv-a" });
    expect(fleet.databases[0]).toMatchObject({ sourceRef: "db-1", engine: "POSTGRES", serverRef: "srv-a" });
    expect(fleet.services[0]).toMatchObject({ sourceRef: "svc-1", templateSlug: "plausible" });
  });

  it("warns about SQLite (no equivalent) and the service needing a sensitive token", () => {
    expect(fleet.warnings.some((w) => /no Tugra equivalent/.test(w))).toBe(true);
    expect(fleet.warnings.some((w) => /service\(s\) need a read:sensitive/.test(w))).toBe(true);
  });

  it("is secret-free — no password/value material anywhere", () => {
    expect(JSON.stringify(fleet)).not.toMatch(/password|secret_value|internal_db_url/i);
  });
});
