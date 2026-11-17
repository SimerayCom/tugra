import {
  mapCoolifyBuildPack,
  coolifyEngine,
  parseFqdns,
  parsePorts,
  versionFromImage,
  mapApplication,
  mapDatabase,
  mapService,
  tlsExpectation,
  parseNetworkAliases,
  buildCoolifyFleet,
  normalizeGitUrl,
  isGithubAppRepo,
  decodeCoolifyLabels,
  decodeCoolifyDockerfile,
  parseWatchPaths,
  parseComposeDomains,
  coolifyGitProvider,
  isValkeyImage,
  appContainerPrefix,
  containerPrefixKnown,
  type CoolifyFleetInput,
} from "./coolify-map";
import { isSensitiveVisible } from "./coolify-sensitive";
import { planImport } from "../import-planner";
import { foreignAppToCreateInput, foreignAppToIngressPlan, foreignAppToPostCreateConfig } from "../apply-map";

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

describe("isGithubAppRepo", () => {
  it("flags a bare owner/repo (Coolify's GitHub-App form = private, needs a connected GitSource)", () => {
    expect(isGithubAppRepo("o/r")).toBe(true);
    expect(isGithubAppRepo("acme/my-app.git")).toBe(true);
    expect(isGithubAppRepo("  acme/my-app  ")).toBe(true);
  });
  it("does NOT flag a full URL / scp form (a plain, usually public clone)", () => {
    expect(isGithubAppRepo("https://github.com/o/r.git")).toBe(false);
    expect(isGithubAppRepo("git@github.com:o/r.git")).toBe(false);
    expect(isGithubAppRepo("ssh://git@host/o/r.git")).toBe(false);
    expect(isGithubAppRepo("some-weird-value")).toBe(false);
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
  it("parsePorts keeps positive in-range integers only", () => {
    expect(parsePorts("3000,8080")).toEqual([3000, 8080]);
    expect(parsePorts("")).toEqual([]);
    expect(parsePorts("70000,0,-1,80")).toEqual([80]); // drop out-of-range (>65535), zero and negative
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
    expect(app.git?.provider).toBe("github"); // owner/repo shorthand → GitHub-App (private) signal for auto-link
  });

  it("does NOT mark provider for a full git URL (a plain/public clone — no auto-link needed)", () => {
    const app = mapApplication(
      { uuid: "app-2", name: "pub", build_pack: "nixpacks", git_repository: "https://github.com/o/pub.git", git_branch: "main" },
      { envs: [], volumes: [], serverRef: "srv-a" },
    );
    expect(app.git?.url).toBe("https://github.com/o/pub.git");
    expect(app.git?.provider).toBeUndefined();
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

  it("carries the facts a run classifies a host by: the control-plane box, the unreachable count and the OS text; a fact the API left out stays out", () => {
    const f = buildCoolifyFleet({
      ...input,
      servers: [
        { uuid: "s1", name: "host-1", ip: "10.0.0.1", is_coolify_host: true, unreachable_count: 12, server_metadata: { os: "Ubuntu", os_release: "26.04.1 LTS" } },
        { uuid: "s2", name: "host-2", is_coolify_host: false, unreachable_count: null, server_metadata: null },
        { uuid: "s3", unreachable_count: -4, server_metadata: { os: 5 } },
      ],
    });
    expect(f.servers).toEqual([
      { ref: "s1", name: "host-1", ip: "10.0.0.1", controlPlane: true, unreachableCount: 12, os: "Ubuntu 26.04.1 LTS" },
      { ref: "s2", name: "host-2", ip: undefined },
      { ref: "s3", name: undefined, ip: undefined },
    ]);
  });

  it("warns about SQLite (no equivalent) and the service needing a sensitive token", () => {
    expect(fleet.warnings.some((w) => /no Tugra equivalent/.test(w))).toBe(true);
    expect(fleet.warnings.some((w) => /service\(s\) need a read:sensitive/.test(w))).toBe(true);
  });

  it("is secret-free — no password/value material anywhere", () => {
    expect(JSON.stringify(fleet)).not.toMatch(/password|secret_value|internal_db_url/i);
  });
});

describe("coolify env flag mapping", () => {
  it("maps is_buildtime / is_runtime / is_literal / is_multiline onto the ForeignEnv (value never carried)", () => {
    const a = mapApplication(
      { uuid: "app-3", name: "f", build_pack: "nixpacks", git_repository: "https://github.com/o/f.git", git_branch: "main" },
      { envs: [{ key: "A", is_buildtime: true, is_runtime: false, is_literal: true, is_multiline: true, value: "SECRET" } as never], volumes: [], serverRef: "srv-a" },
    );
    expect(a.env).toEqual([{ key: "A", buildTime: true, runtime: false, literal: true, multiline: true }]);
    expect(JSON.stringify(a)).not.toContain("SECRET");
  });
});

// ── G3-C: custom_labels / dockerfile decoding, apply-time markers, presence-only coverage ────────────────
// FIXTURE NOTE: the Coolify field names/encodings below (`custom_labels` base64, `dockerfile`/`dockerfile_raw`,
// `is_http_basic_auth_enabled`, `custom_docker_run_options`, ...) are HAND-BUILT from Coolify v4 sources. They are
// UNVERIFIED against a live instance until the lab checks in the G3-C spec (section 11) are done.
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const TRAEFIK_BLOCK = ["traefik.enable=true", "traefik.http.routers.http-0-abc.rule=Host(`a.example.com`) && PathPrefix(`/`)", "caddy_0=a.example.com"].join("\n");

describe("decodeCoolifyLabels", () => {
  it("parses a plain multiline block in order", () => {
    expect(decodeCoolifyLabels("a=1\nb=2")).toEqual([{ key: "a", value: "1" }, { key: "b", value: "2" }]);
  });
  it("decodes a base64 block (Coolify's API form)", () => {
    expect(decodeCoolifyLabels(b64(TRAEFIK_BLOCK))).toEqual([
      { key: "traefik.enable", value: "true" },
      { key: "traefik.http.routers.http-0-abc.rule", value: "Host(`a.example.com`) && PathPrefix(`/`)" },
      { key: "caddy_0", value: "a.example.com" },
    ]);
  });
  it("tolerates CRLF, comments, blank lines, a `- ` prefix and surrounding quotes", () => {
    expect(decodeCoolifyLabels('# c\r\n\r\n- a=1\r\n"b=2"\r\n\'c=3\'')).toEqual([{ key: "a", value: "1" }, { key: "b", value: "2" }, { key: "c", value: "3" }]);
  });
  it("splits at the FIRST = (a value may contain =)", () => {
    expect(decodeCoolifyLabels("k=a=b=c")).toEqual([{ key: "k", value: "a=b=c" }]);
  });
  it("skips a line with no = but keeps the rest", () => {
    expect(decodeCoolifyLabels("garbage\nk=v")).toEqual([{ key: "k", value: "v" }]);
  });
  it("non-string / empty / whitespace input gives []", () => {
    for (const v of [undefined, null, 5, {}, "", "  \n "]) expect(decodeCoolifyLabels(v)).toEqual([]);
  });
  it("a base64-shaped value that decodes to non-UTF-8 or has no = is NOT decoded (read as plain text)", () => {
    const binary = Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString("base64"); // "//79/A==" is valid base64 of invalid UTF-8
    expect(decodeCoolifyLabels(binary)).toEqual([{ key: "//79/A", value: "=" }]); // split as plain `key=value` (its key is later dropped as invalid)
    const noEq = b64("no equals sign here");
    expect(decodeCoolifyLabels(noEq)).toEqual([{ key: noEq.replace(/=+$/, ""), value: "=" }]); // decoded text has no =, so it stays as written
  });
  it("a block that is only garbage is unparsable; an oversized block is refused", () => {
    expect(decodeCoolifyLabels("just words\nmore words")).toBe("unparsable");
    expect(decodeCoolifyLabels("k=" + "x".repeat(65 * 1024))).toBe("unparsable");
  });
});

describe("decodeCoolifyDockerfile", () => {
  const DF = "FROM node:20\nCMD [\"node\"]\n";
  it("returns valid plain text as-is and decodes valid base64", () => {
    expect(decodeCoolifyDockerfile(DF)).toBe(DF);
    expect(decodeCoolifyDockerfile(b64(DF))).toBe(DF);
  });
  it("base64 that decodes to a bad Dockerfile stays raw (the apply-time validator rejects it)", () => {
    const raw = b64("RUN echo hi");
    expect(decodeCoolifyDockerfile(raw)).toBe(raw);
  });
  it("whitespace-only or non-string gives undefined", () => {
    for (const v of ["", "  \n", undefined, null, 3]) expect(decodeCoolifyDockerfile(v)).toBeUndefined();
  });
});

describe("mapApplication — extras markers + notCarried", () => {
  const ctx = { envs: [], volumes: [] };
  const git = { uuid: "a", name: "api", git_repository: "https://github.com/o/r.git", git_branch: "main" };

  it("sets the secret-free markers only for a non-empty label block / Dockerfile on a dockerfile app", () => {
    const a = mapApplication({ ...git, build_pack: "dockerfile", custom_labels: b64(TRAEFIK_BLOCK), dockerfile: "FROM x\nRUN SECRET_TEXT" }, ctx);
    expect(a.sourceExtras).toEqual({ labels: true, dockerfile: true });
    expect(JSON.stringify(a)).not.toMatch(/SECRET_TEXT|traefik|a\.example\.com/); // presence only, never the text
    const b = mapApplication({ ...git, build_pack: "nixpacks", custom_labels: "  ", dockerfile: "FROM x" }, ctx);
    expect(b.sourceExtras).toBeUndefined();
    const c = mapApplication({ ...git, build_pack: "dockerfile", dockerfile_raw: "FROM x" }, ctx);
    expect(c.sourceExtras).toEqual({ dockerfile: true });
  });

  it("an app with none of the new fields maps exactly as before (no new keys)", () => {
    const a = mapApplication({ ...git, build_pack: "nixpacks", ports_exposes: "3000" }, ctx);
    expect("sourceExtras" in a).toBe(false);
    expect("notCarried" in a).toBe(false);
  });

  it("emits one fixed-reason coverage row per present source field and none for absent / '0' / false", () => {
    const a = mapApplication(
      { ...git, build_pack: "dockerfile", is_http_basic_auth_enabled: true, ports_mappings: "8080:80", custom_docker_run_options: "--cap-add=NET_ADMIN --secret-flag=SUPERSECRET", pre_deployment_command: "migrate", limits_memory: "512m", health_check_enabled: true, dockerfile_target_build: "prod", watch_paths: "src/**" },
      ctx,
    );
    expect(a.notCarried!.map((n) => `${n.level}:${n.field}`).sort()).toEqual([
      "info:deployHooks", "info:dockerBuildTarget", "info:healthcheck", "info:limits",
      "warn:basicAuth", "warn:dockerOptions", "warn:publishedPorts",
    ]);
    expect(JSON.stringify(a.notCarried)).not.toMatch(/SUPERSECRET|NET_ADMIN|migrate|8080|512m/);
    const none = mapApplication({ ...git, build_pack: "nixpacks", is_http_basic_auth_enabled: false, ports_mappings: "", limits_memory: "0", limits_cpus: "0", health_check_enabled: false, watch_paths: "" }, ctx);
    expect(none.notCarried).toBeUndefined();
  });

  it("a repo-less inline-Dockerfile app (the planner blocker case) gets an inlineDockerfile warn; the blocker itself is unchanged", () => {
    const placeholder = { uuid: "d", name: "df", build_pack: "dockerfile", git_repository: "coollabsio/coolify", git_branch: "main", dockerfile: "FROM x" };
    const a = mapApplication(placeholder, ctx);
    expect(a.notCarried).toEqual([expect.objectContaining({ field: "inlineDockerfile", level: "warn" })]);
    const plan = planImport({ servers: [], apps: [a], databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] }, { sourceKind: "coolify" });
    expect(plan.items[0].risks).toEqual([expect.objectContaining({ level: "blocker", code: "app.git.missing" })]);
    // an image-backed app with a dockerfile build_pack is NOT the blocker case
    expect(mapApplication({ ...placeholder, docker_registry_image_name: "nginx" }, ctx).notCarried).toBeUndefined();
  });

  it("neither sourceExtras nor notCarried reaches the plan item `proposed` or changes planHash", () => {
    const plain = mapApplication({ ...git, build_pack: "dockerfile" }, ctx);
    const rich = mapApplication({ ...git, build_pack: "dockerfile", custom_labels: "a=b", dockerfile: "FROM x", is_http_basic_auth_enabled: true }, ctx);
    const fleet = (apps: typeof plain[]) => ({ servers: [], apps, databases: [], services: [], volumes: [], sharedEnv: [], warnings: [] });
    const p1 = planImport(fleet([plain]), { sourceKind: "coolify" });
    const p2 = planImport(fleet([rich]), { sourceKind: "coolify" });
    expect(p2.planHash).toBe(p1.planHash);
    expect(JSON.stringify(p2.items)).not.toMatch(/sourceExtras|notCarried/);
  });
});


describe("mapService — members, domains, placement (G4-C)", () => {
  const row = {
    uuid: "svc1",
    name: "stack",
    service_type: "signoz",
    docker_compose_raw: "services:\n  a:\n    image: x:1\n",
    server: { uuid: "srv-row", name: "box" },
    applications: [
      { uuid: "m2", name: "zeta", fqdn: "https://z.example.test:8080,http://z.example.test:8080", image: "z:1" },
      { uuid: "m1", name: "alpha", fqdn: null, image: "a:1" },
      { uuid: "m3", name: "mid", fqdn: "" },
    ],
    databases: [{ uuid: "d1", name: "init", image: "i:1" }],
  };

  it("maps members sorted by name, db members as kind db without domains, fqdn via parseFqdns (pair deduped, port kept, serviceRef set)", () => {
    const s = mapService(row, {});
    expect(s.members!.map((m) => `${m.kind}:${m.name}`)).toEqual(["app:alpha", "db:init", "app:mid", "app:zeta"]);
    expect(s.members!.find((m) => m.name === "zeta")).toMatchObject({ ref: "m2", image: "z:1", domains: [{ host: "z.example.test", https: true, port: 8080, serviceRef: "zeta", primary: false }] });
    expect(s.members!.find((m) => m.name === "init")!.domains).toEqual([]);
    expect(s.members!.find((m) => m.name === "mid")!.domains).toEqual([]);
    expect(s.memberApps).toEqual(["m2", "m1", "m3"]);
    expect(s.memberDbs).toEqual(["d1"]);
  });

  it("serverRef falls back to the row's own server; the listing wins when it names the service; serverName is display only", () => {
    expect(mapService(row, {}).serverRef).toBe("srv-row");
    expect(mapService(row, { serverRef: "srv-list" }).serverRef).toBe("srv-list");
    expect(mapService(row, {}).serverName).toBe("box");
    expect(mapService({ ...row, server: null }, {}).serverRef).toBeUndefined();
  });

  it("keeps the raw compose on the service and the templateSlug", () => {
    const s = mapService(row, {});
    expect(s.composeFile).toContain("services:");
    expect(s.templateSlug).toBe("signoz");
  });

  it("the need-read:sensitive warning stays only for a service WITHOUT a raw compose", () => {
    const fleet = buildCoolifyFleet({ servers: [], resourcesByServer: {}, apps: [], databases: [], services: [row, { uuid: "svc2", name: "x" }], envsByResource: {}, volumesByResource: {} });
    expect(fleet.warnings.filter((w) => /service\(s\) need a read:sensitive/.test(w))).toEqual(["1 service(s) need a read:sensitive token to fetch their compose file before import"]);
  });
});

describe("tlsExpectation / mapDatabase tls (R22)", () => {
  const pg = (o: Record<string, unknown>) => ({ uuid: "d1", database_type: "standalone-postgresql", ...o }) as never;
  it("ssl_mode require with enable_ssl off (the real fleet shape) still means the clients expect TLS", () => {
    expect(tlsExpectation(pg({ enable_ssl: false, ssl_mode: "require" }))).toEqual({ enabled: false, mode: "require" });
    expect(tlsExpectation(pg({ enable_ssl: true, ssl_mode: "Verify-Full" }))).toEqual({ enabled: true, mode: "verify-full" });
    expect(tlsExpectation(pg({ enable_ssl: true }))).toEqual({ enabled: true });
  });
  it("no expectation for prefer/allow/disable/absent, nor for another engine", () => {
    for (const ssl_mode of ["prefer", "allow", "disable", "", null, undefined]) expect(tlsExpectation(pg({ enable_ssl: false, ssl_mode }))).toBeUndefined();
    expect(tlsExpectation({ uuid: "d2", database_type: "standalone-redis", enable_ssl: true, ssl_mode: "require" } as never)).toBeUndefined();
  });
  it("mapDatabase carries it only when present, and never changes the plan hash", () => {
    const base = { uuid: "d1", name: "x", database_type: "standalone-postgresql", image: "postgres:16" } as never;
    const withTls = mapDatabase({ ...(base as object), enable_ssl: false, ssl_mode: "require" } as never, { volumes: [] });
    const without = mapDatabase(base, { volumes: [] });
    expect(withTls.tls).toEqual({ enabled: false, mode: "require" });
    expect(Object.prototype.hasOwnProperty.call(without, "tls")).toBe(false);
    const fleet = (d: unknown) => ({ servers: [], apps: [], databases: [d], services: [], volumes: [], sharedEnv: [], warnings: [] }) as never;
    expect(planImport(fleet(withTls), { sourceKind: "coolify" }).planHash).toBe(planImport(fleet(without), { sourceKind: "coolify" }).planHash);
  });
});

describe("parseNetworkAliases / mapApplication networkAliases (C17)", () => {
  it("splits a comma/space separated string or a list, lower-cases, dedupes and drops anything that is not a host name", () => {
    expect(parseNetworkAliases("Api.Internal, app.internal  api.internal")).toEqual(["api.internal", "app.internal"]);
    expect(parseNetworkAliases(["a.b", "bad host", "-x", "ok-1", 5 as never])).toEqual(["a.b", "ok-1"]);
    expect(parseNetworkAliases(null)).toEqual([]);
    expect(parseNetworkAliases("")).toEqual([]);
    expect(parseNetworkAliases(Array.from({ length: 30 }, (_, i) => `h${i}`))).toHaveLength(20);
  });
  it("mapApplication carries them only when present", () => {
    const base = { uuid: "a1", name: "x", build_pack: "dockerfile", git_repository: "o/r" } as never;
    expect(mapApplication({ ...(base as object), custom_network_aliases: "api.internal" } as never, { envs: [], volumes: [] }).networkAliases).toEqual(["api.internal"]);
    expect(Object.prototype.hasOwnProperty.call(mapApplication(base, { envs: [], volumes: [] }), "networkAliases")).toBe(false);
  });
});

describe("watch_paths carry (R16)", () => {
  const ctx = { envs: [], volumes: [] };
  const git = { uuid: "a", name: "api", build_pack: "nixpacks", git_repository: "org/mono", git_branch: "main" };

  it("parseWatchPaths splits lines and top-level commas, keeps commas inside braces, drops a leading slash, blanks and repeats", () => {
    expect(parseWatchPaths("apps/web/**\r\n/packages/**\n\n!/apps/web/docs/**\napps/web/**")).toEqual(["apps/web/**", "packages/**", "!apps/web/docs/**"]);
    expect(parseWatchPaths("src/**, lib/{a,b}/**,  ")).toEqual(["src/**", "lib/{a,b}/**"]);
    expect(parseWatchPaths(null)).toEqual([]);
    expect(parseWatchPaths("  \n ")).toEqual([]);
  });

  it("mapApplication carries them in ForeignApp.watchPaths (no more `not carried` row) and the apply step accepts them", () => {
    const a = mapApplication({ ...git, watch_paths: "apps/api/**\n/packages/shared/**" }, ctx);
    expect(a.watchPaths).toEqual(["apps/api/**", "packages/shared/**"]);
    expect((a.notCarried ?? []).some((n) => n.field === "watchPaths")).toBe(false);
    const cfg = foreignAppToPostCreateConfig(a);
    expect(cfg.watchPaths).toEqual(["apps/api/**", "packages/shared/**"]);
    expect(cfg.unmapped.some((u) => u.field === "watchPaths")).toBe(false);
  });

  it("an app without watch_paths has no watchPaths key, and an invalid pattern is reported by the apply step instead of dropped silently", () => {
    expect("watchPaths" in mapApplication({ ...git, watch_paths: "" }, ctx)).toBe(false);
    const bad = foreignAppToPostCreateConfig(mapApplication({ ...git, watch_paths: "src/**\nhas space/**" }, ctx));
    expect(bad.watchPaths).toBeUndefined();
    expect(bad.unmapped).toEqual([expect.objectContaining({ field: "watchPaths", reasonCode: "watch_paths_invalid" })]);
  });
});

describe("static site, redirect mode and redis conf (R18 / R19 / R48)", () => {
  const ctx = { envs: [], volumes: [] };
  const git = { uuid: "a", name: "site", git_repository: "org/site", git_branch: "main" };

  it("a nixpacks/railpack app Coolify marks is_static becomes a STATIC build with its build command and output directory", () => {
    const a = mapApplication({ ...git, build_pack: "nixpacks", is_static: true, build_command: "npm run build", publish_directory: "/dist" }, ctx);
    expect(a).toMatchObject({ kind: "git", buildPack: "static", publishDirectory: "/dist", buildCommand: "npm run build" });
    const input = foreignAppToCreateInput(a, {}, { serverId: "srv" });
    expect(input).toMatchObject({ source: "GIT", buildType: "STATIC", buildCommand: "npm run build", outputDir: "dist" });
    expect(mapCoolifyBuildPack({ ...git, build_pack: "railpack", is_static: true })).toEqual({ kind: "git", buildPack: "static" });
  });

  it("is_static is ignored for any other pack, for a false flag and for an app without a real repo", () => {
    expect(mapCoolifyBuildPack({ ...git, build_pack: "nixpacks", is_static: false }).buildPack).toBe("nixpacks");
    expect(mapCoolifyBuildPack({ ...git, build_pack: "dockerfile", is_static: true }).buildPack).toBe("dockerfile");
    expect(mapCoolifyBuildPack({ uuid: "i", build_pack: "dockerimage", docker_registry_image_name: "nginx", is_static: true })).toEqual({ kind: "image", buildPack: "image" });
  });

  it("a static site that does not fall back to index.html reports the Tugra SPA fallback at apply; an SPA or unset flag reports nothing", () => {
    const off = mapApplication({ ...git, build_pack: "static", is_spa: false }, ctx);
    expect(off.staticSpa).toBe(false);
    expect(foreignAppToPostCreateConfig(off).unmapped).toEqual([expect.objectContaining({ field: "staticSpa", reasonCode: "static_spa" })]);
    expect("staticSpa" in mapApplication({ ...git, build_pack: "static", is_spa: true }, ctx)).toBe(false);
    expect("staticSpa" in mapApplication({ ...git, build_pack: "nixpacks", is_spa: false }, ctx)).toBe(false);
  });

  it("the www / non-www redirect mode is reported in the plan coverage with its mode; `both` and an unset mode say nothing", () => {
    const www = mapApplication({ ...git, build_pack: "nixpacks", redirect: "www" }, ctx);
    expect(www.notCarried).toEqual([expect.objectContaining({ field: "redirectMode", level: "info", reasonCode: "coolify_redirect", reasonParams: { mode: "www" } })]);
    expect(mapApplication({ ...git, build_pack: "nixpacks", redirect: "non-www" }, ctx).notCarried?.[0]).toMatchObject({ reasonParams: { mode: "non-www" } });
    expect(mapApplication({ ...git, build_pack: "nixpacks", redirect: "both" }, ctx).notCarried).toBeUndefined();
    expect(mapApplication({ ...git, build_pack: "nixpacks" }, ctx).notCarried).toBeUndefined();
  });

  it("a custom redis.conf is reported as a manual step on the redis database and reaches the plan as a warn risk, never its text", () => {
    const db = { uuid: "r1", name: "cache", database_type: "standalone-redis", image: "redis:7", redis_conf: "maxmemory 2gb\nrequirepass SUPERSECRET" };
    const mapped = mapDatabase(db, { volumes: [] });
    expect(mapped.notCarried).toEqual([expect.objectContaining({ field: "redisConf", level: "warn", reasonCode: "coolify_redis_conf" })]);
    expect(JSON.stringify(mapped)).not.toMatch(/SUPERSECRET|maxmemory/);
    const plan = planImport({ servers: [], apps: [], databases: [mapped], services: [], volumes: [], sharedEnv: [], warnings: [] }, { sourceKind: "coolify" });
    expect(plan.items[0].risks).toContainEqual(expect.objectContaining({ level: "warn", code: "db.notCarried.redisConf" }));
    expect(JSON.stringify(plan)).not.toMatch(/SUPERSECRET|maxmemory/);
    expect("notCarried" in mapDatabase({ ...db, redis_conf: "" }, { volumes: [] })).toBe(false);
    expect("notCarried" in mapDatabase({ ...db, database_type: "standalone-postgresql", image: "postgres:17", redis_conf: "x" }, { volumes: [] })).toBe(false);
  });
});

describe("compose app domains (R9, docker_compose_domains)", () => {
  const ctx = { envs: [], volumes: [] };
  // The 4.7.5 shape: fqdn is empty, the domains live per service in a JSON string.
  const composeApp = {
    uuid: "c1",
    name: "stack",
    build_pack: "dockercompose",
    git_repository: "org/stack",
    git_branch: "main",
    fqdn: null,
    docker_compose_domains: JSON.stringify({ web: { domain: "https://app.example.test:3000,http://app.example.test:3000,https://www.example.test:3000" }, api: { domain: "https://api.example.test:8080" } }),
  };

  it("parseComposeDomains reads the JSON string: per service, a comma list, http/https pair collapsed, port kept, none primary", () => {
    expect(parseComposeDomains(composeApp.docker_compose_domains)).toEqual([
      { host: "app.example.test", https: true, port: 3000, path: undefined, primary: false, serviceRef: "web" },
      { host: "www.example.test", https: true, port: 3000, path: undefined, primary: false, serviceRef: "web" },
      { host: "api.example.test", https: true, port: 8080, path: undefined, primary: false, serviceRef: "api" },
    ]);
  });

  it("tolerates an object, the {name, domain} list form, a null / empty / invalid value and a service without a domain", () => {
    expect(parseComposeDomains({ web: { domain: "https://a.example.test" } })).toHaveLength(1);
    expect(parseComposeDomains([{ name: "web", domain: "https://a.example.test" }, { name: "x" }, { domain: "https://noname.example.test" }])).toEqual([expect.objectContaining({ host: "a.example.test", serviceRef: "web" })]);
    for (const bad of [null, undefined, "", "  ", "{not json", "[]", "{}", 7, '{"web":{}}']) expect(parseComposeDomains(bad)).toEqual([]);
  });

  it("mapApplication maps a compose app's domains from docker_compose_domains (fqdn empty)", () => {
    const a = mapApplication(composeApp, ctx);
    expect(a.kind).toBe("compose");
    expect(a.domains!.map((d) => `${d.serviceRef}:${d.host}:${d.port}`)).toEqual(["web:app.example.test:3000", "web:www.example.test:3000", "api:api.example.test:8080"]);
    expect(a.domains!.some((d) => d.primary)).toBe(false);
  });

  it("a compose row of an older instance that still has an fqdn keeps those hosts too, without repeating a service host", () => {
    const a = mapApplication({ ...composeApp, fqdn: "https://app.example.test:3000,https://legacy.example.test" }, ctx);
    expect(a.domains!.map((d) => d.host)).toEqual(["app.example.test", "www.example.test", "api.example.test", "legacy.example.test"]);
    expect(a.domains!.find((d) => d.host === "legacy.example.test")!.serviceRef).toBeUndefined();
    expect(a.domains!.some((d) => d.primary)).toBe(false);
  });

  it("docker_compose_domains is ignored on a non-compose app (its fqdn is the source of truth) and a compose app without it maps its fqdn as before", () => {
    expect(mapApplication({ uuid: "n", build_pack: "nixpacks", git_repository: "o/r", fqdn: "https://x.example.test", docker_compose_domains: composeApp.docker_compose_domains }, ctx).domains!.map((d) => d.host)).toEqual(["x.example.test"]);
    expect(mapApplication({ ...composeApp, docker_compose_domains: null, fqdn: "https://old.example.test" }, ctx).domains).toEqual([expect.objectContaining({ host: "old.example.test", primary: true })]);
  });

  it("the per-service domains reach the apply step as service domains (the first one is the create-time domain, as for any compose source)", () => {
    const a = mapApplication({ ...composeApp, docker_compose_raw: "services:\n  web:\n    image: x:1\n  api:\n    image: y:1\n" }, ctx);
    const plan = foreignAppToIngressPlan(a);
    expect(plan.serviceDomains).toEqual([{ service: "web", hostname: "www.example.test", port: 3000 }, { service: "api", hostname: "api.example.test", port: 8080 }]);
    expect(foreignAppToCreateInput(a, {}, { serverId: "srv" })).toMatchObject({ source: "COMPOSE", domain: "app.example.test" });
  });
});

describe("git provider from source_type (R10)", () => {
  const ctx = { envs: [], volumes: [] };
  const git = { uuid: "a", name: "x", build_pack: "nixpacks", git_branch: "main" };

  it("coolifyGitProvider names the provider of GithubApp / GitlabApp / GiteaApp, also as a full model class, and nothing else", () => {
    expect(coolifyGitProvider("GithubApp")).toBe("github");
    expect(coolifyGitProvider("GitlabApp")).toBe("gitlab");
    expect(coolifyGitProvider("GiteaApp")).toBe("gitea");
    expect(coolifyGitProvider("App\\Models\\GithubApp")).toBe("github");
    for (const other of [undefined, null, "", "Server", 5]) expect(coolifyGitProvider(other as string)).toBeUndefined();
  });

  it("a GitLab / Gitea App repo is that provider and its bare owner/repo is NOT rewritten to github.com", () => {
    const gl = mapApplication({ ...git, git_repository: "grp/proj", source_type: "GitlabApp" }, ctx);
    expect(gl.git).toMatchObject({ url: "grp/proj", provider: "gitlab" });
    const gt = mapApplication({ ...git, git_repository: "me/proj", source_type: "GiteaApp" }, ctx);
    expect(gt.git).toMatchObject({ url: "me/proj", provider: "gitea" });
    expect(normalizeGitUrl("grp/proj", "GitlabApp")).toBe("grp/proj");
  });

  it("a GithubApp repo is github with the github.com clone URL", () => {
    expect(mapApplication({ ...git, git_repository: "org/repo", source_type: "GithubApp" }, ctx).git).toMatchObject({ url: "https://github.com/org/repo.git", provider: "github" });
  });

  it("a clone URL is never labelled by source_type (Coolify points public and deploy-key repos at the built-in GithubApp source)", () => {
    for (const repo of ["git@gitlab.com:o/r.git", "ssh://git@host.example.test/o/r.git", "https://gitlab.example.test/o/r.git"]) {
      expect(mapApplication({ ...git, git_repository: repo, source_type: "GithubApp" }, ctx).git).toMatchObject({ url: repo, provider: undefined });
      expect(mapApplication({ ...git, git_repository: repo, source_type: "GitlabApp" }, ctx).git!.provider).toBeUndefined();
    }
  });

  it("without source_type (4.1.2 to 4.6) the old owner/repo heuristic decides", () => {
    expect(mapApplication({ ...git, git_repository: "org/repo" }, ctx).git).toMatchObject({ url: "https://github.com/org/repo.git", provider: "github" });
    expect(mapApplication({ ...git, git_repository: "https://git.example.test/org/repo.git" }, ctx).git!.provider).toBeUndefined();
    expect(mapApplication({ ...git, git_repository: "org/repo", source_type: null }, ctx).git!.provider).toBe("github");
    expect(mapApplication({ ...git, git_repository: "org/repo", source_type: "SomethingNew" }, ctx).git!.provider).toBe("github");
  });
});

describe("static flags in settings (R4)", () => {
  const ctx = { envs: [], volumes: [] };
  const git = { uuid: "a", name: "site", git_repository: "org/site", git_branch: "main" };

  it("settings.is_static / is_spa (4.7 detail read) drive the mapping like the old top-level fields", () => {
    expect(mapApplication({ ...git, build_pack: "nixpacks", settings: { is_static: true } }, ctx).buildPack).toBe("static");
    expect(mapCoolifyBuildPack({ ...git, build_pack: "railpack", settings: { is_static: true } })).toEqual({ kind: "git", buildPack: "static" });
    expect(mapApplication({ ...git, build_pack: "static", settings: { is_spa: false } }, ctx).staticSpa).toBe(false);
    expect(mapApplication({ ...git, build_pack: "nixpacks", settings: { is_static: false } }, ctx).buildPack).toBe("nixpacks");
  });

  it("the nested value wins over a stale top-level one; either alone is enough", () => {
    expect(mapCoolifyBuildPack({ ...git, build_pack: "nixpacks", is_static: true, settings: { is_static: false } }).buildPack).toBe("nixpacks");
    expect(mapCoolifyBuildPack({ ...git, build_pack: "nixpacks", is_static: true, settings: {} }).buildPack).toBe("static");
  });
});

describe("sensitive fields hidden by the token (R5)", () => {
  it("isSensitiveVisibleRow is by KEY presence: a gated key is absent (not null) on a plain token, present (even null) otherwise", () => {
    expect(isSensitiveVisible({ uuid: "a", build_pack: "nixpacks" })).toBe(false);
    expect(isSensitiveVisible({ uuid: "a", start_command: null })).toBe(true);
    expect(isSensitiveVisible({ uuid: "a", build_command: "npm run build" })).toBe(true);
    expect(isSensitiveVisible({ uuid: "d" }, "database")).toBe(false);
    expect(isSensitiveVisible({ uuid: "d", custom_docker_run_options: null }, "database")).toBe(true);
    expect(isSensitiveVisible({ uuid: "s" }, "service")).toBe(false);
    expect(isSensitiveVisible({ uuid: "s", docker_compose_raw: "x" }, "service")).toBe(true);
  });

  const input = (apps: CoolifyFleetInput["apps"], databases: CoolifyFleetInput["databases"] = []): CoolifyFleetInput => ({ servers: [], resourcesByServer: {}, apps, databases, services: [], envsByResource: {}, volumesByResource: {} });

  it("the fleet gets ONE warning counting the apps and databases read without the gated fields, naming the fix", () => {
    const fleet = buildCoolifyFleet(input([{ uuid: "a" }, { uuid: "b", start_command: null }, { uuid: "c" }], [{ uuid: "d", database_type: "standalone-redis" }]));
    const warns = fleet.warnings.filter((w) => /sensitive fields/.test(w));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/2 application\(s\)/);
    expect(warns[0]).toMatch(/1 database\(s\)/);
    expect(warns[0]).toMatch(/NOT be carried/);
    expect(warns[0]).toMatch(/read:sensitive ability as a team admin or owner/);
  });

  it("no warning for rows that carry the keys (4.1.2 to 4.6, or a read:sensitive 4.7 token) or for an empty fleet", () => {
    const row = { uuid: "a", install_command: null, build_command: null, start_command: null };
    expect(buildCoolifyFleet(input([row], [{ uuid: "d", custom_docker_run_options: null } as never])).warnings.filter((w) => /sensitive fields/.test(w))).toEqual([]);
    expect(buildCoolifyFleet(input([])).warnings).toEqual([]);
  });

  it("the warning reaches the plan", () => {
    const fleet = buildCoolifyFleet(input([{ uuid: "a", build_pack: "dockerfile" }]));
    expect(planImport(fleet, { sourceKind: "coolify" }).warnings.some((w) => /sensitive fields/.test(w))).toBe(true);
  });
});

describe("service members and server name (R8)", () => {
  it("members the compose no longer declares are skipped everywhere", () => {
    const s = mapService(
      {
        uuid: "s1",
        applications: [{ uuid: "m1", name: "web" }, { uuid: "m2", name: "gone", is_removed_from_compose: true }],
        databases: [{ uuid: "d1", name: "db", is_removed_from_compose: false }, { uuid: "d2", name: "olddb", is_removed_from_compose: true }],
      },
      {},
    );
    expect(s.members!.map((m) => m.name)).toEqual(["db", "web"]);
    expect(s.memberApps).toEqual(["m1"]);
    expect(s.memberDbs).toEqual(["d1"]);
  });

  it("the server name comes from the row (older), the detail's destination.server, or the server list; the row wins", () => {
    expect(mapService({ uuid: "s", destination: { server: { uuid: "x", name: "dest" } } }, {})).toMatchObject({ serverRef: "x", serverName: "dest" });
    expect(mapService({ uuid: "s", server: { uuid: "r", name: "row" }, destination: { server: { uuid: "x", name: "dest" } } }, {}).serverName).toBe("row");
    expect(mapService({ uuid: "s" }, { serverRef: "srv-a", serverName: "listed" })).toMatchObject({ serverRef: "srv-a", serverName: "listed" });
    expect("serverName" in mapService({ uuid: "s" }, {})).toBe(false);
    const fleet = buildCoolifyFleet({ servers: [{ uuid: "srv-a", name: "box" }], resourcesByServer: { "srv-a": ["s"] }, apps: [], databases: [], services: [{ uuid: "s", docker_compose_raw: "x" }], envsByResource: {}, volumesByResource: {} });
    expect(fleet.services[0]).toMatchObject({ serverRef: "srv-a", serverName: "box" });
  });
});

describe("Valkey databases (R12, standalone-redis on valkey/valkey)", () => {
  const valkey = { uuid: "v1", name: "cache", database_type: "standalone-redis", image: "valkey/valkey:9-alpine" };

  it("isValkeyImage matches the Valkey repositories, with a registry prefix, and nothing else", () => {
    for (const ok of ["valkey/valkey:9-alpine", "docker.io/valkey/valkey:8", "registry.example.test:5000/valkey:7", "valkey/valkey-bundle:9", "valkey"]) expect(isValkeyImage(ok)).toBe(true);
    for (const no of ["redis:7.2", "bitnami/redis:7", "myorg/not-valkey-ui:1", "eqalpha/keydb", "", null, undefined]) expect(isValkeyImage(no)).toBe(false);
  });

  it("maps to REDIS (database_type, or the image when the type is missing), keeping the image but NOT the Valkey tag as a Redis version", () => {
    const m = mapDatabase(valkey, { volumes: [] });
    expect(m).toMatchObject({ engine: "REDIS", image: "valkey/valkey:9-alpine", sourceRef: "v1" });
    expect(m.version).toBeUndefined();
    expect(coolifyEngine({ uuid: "v", image: "valkey/valkey:9-alpine" })).toBe("REDIS");
    expect(mapDatabase({ ...valkey, database_type: undefined }, { volumes: [] }).engine).toBe("REDIS");
    expect(buildCoolifyFleet({ servers: [], resourcesByServer: {}, apps: [], databases: [valkey], services: [], envsByResource: {}, volumesByResource: {} }).warnings.filter((w) => /no Tugra equivalent/.test(w))).toEqual([]);
  });

  it("says so in the plan (info row, no blocker) and combines with a custom redis.conf", () => {
    const m = mapDatabase({ ...valkey, redis_conf: "maxmemory 1gb" }, { volumes: [] });
    expect(m.notCarried).toEqual([expect.objectContaining({ field: "engineFamily", level: "info", reasonCode: "coolify_valkey" }), expect.objectContaining({ field: "redisConf", level: "warn" })]);
    const plan = planImport({ servers: [], apps: [], databases: [m], services: [], volumes: [], sharedEnv: [], warnings: [] }, { sourceKind: "coolify" });
    expect(plan.items[0].risks.filter((r) => r.level === "blocker")).toEqual([]);
    expect(plan.items[0].risks).toContainEqual(expect.objectContaining({ code: "db.notCarried.engineFamily", level: "info" }));
  });

  it("a Redis image keeps its version and gets no Valkey note", () => {
    const m = mapDatabase({ uuid: "r", database_type: "standalone-redis", image: "redis:7.2" }, { volumes: [] });
    expect(m).toMatchObject({ engine: "REDIS", version: "7.2" });
    expect("notCarried" in m).toBe(false);
  });
});

describe("custom container name prefix", () => {
  const U = "x8kc0sw4cw0c0ooc0o4gg0ck";
  it("appContainerPrefix reads settings.custom_container_name_prefix (4.7) or the flat column, trimmed, and drops the unusable", () => {
    expect(appContainerPrefix({ uuid: U, settings: { custom_container_name_prefix: "shop" } })).toBe("shop");
    expect(appContainerPrefix({ uuid: U, custom_container_name_prefix: " shop-2 " })).toBe("shop-2");
    expect(appContainerPrefix({ uuid: U, settings: { custom_container_name_prefix: "shop" }, custom_container_name_prefix: "flat" })).toBe("shop"); // the nested value wins
    for (const v of [null, undefined, "", "   ", "sh op", "x;id", "-x", U]) expect([v, appContainerPrefix({ uuid: U, settings: { custom_container_name_prefix: v as string | null } })]).toEqual([v, undefined]);
    expect(appContainerPrefix({ uuid: U })).toBeUndefined();
  });

  it("containerPrefixKnown: the setting present (even null) or a pre-4.7 row means no detail read is needed", () => {
    expect(containerPrefixKnown({})).toBe(false);
    expect(containerPrefixKnown({ settings: { is_static: true } })).toBe(false);
    expect(containerPrefixKnown({ settings: { custom_container_name_prefix: null } })).toBe(true);
    expect(containerPrefixKnown({ custom_container_name_prefix: null })).toBe(true);
    expect(containerPrefixKnown({ is_static: false })).toBe(true);
    expect(containerPrefixKnown({ is_spa: true })).toBe(true);
  });

  it("mapApplication carries it on the ForeignApp and leaves it out when there is none", () => {
    const base = { uuid: U, name: "web", build_pack: "dockerfile", git_repository: "o/r" };
    expect(mapApplication({ ...base, settings: { custom_container_name_prefix: "shop" } }, { envs: [], volumes: [] }).containerPrefix).toBe("shop");
    expect(mapApplication(base, { envs: [], volumes: [] })).not.toHaveProperty("containerPrefix");
    expect(mapApplication(base, { envs: [], volumes: [] }).sourceRef).toBe(U);
  });
});
