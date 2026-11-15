import {
  mapCoolifyBuildPack,
  coolifyEngine,
  parseFqdns,
  parsePorts,
  versionFromImage,
  mapApplication,
  mapDatabase,
  mapService,
  buildCoolifyFleet,
  normalizeGitUrl,
  isGithubAppRepo,
  decodeCoolifyLabels,
  decodeCoolifyDockerfile,
  type CoolifyFleetInput,
} from "./coolify-map";
import { planImport } from "../import-planner";

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
      "info:deployHooks", "info:dockerBuildTarget", "info:healthcheck", "info:limits", "info:watchPaths",
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
