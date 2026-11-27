import { buildCaproverFleet, caproverEngine, dbCredentialsFromEnv, deployedImage, isDatabaseApp, mapApplication, mapPublishedPorts, repoUrl, type CaproverAppDefinition } from "./caprover-map";
import { CAPROVER_SENTINELS, caproverDefinitions } from "../__fixtures__/caprover.fixture";

const defs = () => caproverDefinitions() as unknown as CaproverAppDefinition[];
const fleet = () => buildCaproverFleet({ definitions: defs(), rootDomain: "captain.example.com" });
const app = (name: string) => fleet().apps.find((a) => a.sourceRef === name)!;

describe("caprover-map: the discovered fleet is secret-free", () => {
  it("carries no secret value, git credential or basic-auth password anywhere", () => {
    const text = JSON.stringify(fleet());
    for (const s of CAPROVER_SENTINELS) expect(text).not.toContain(s);
  });

  it("keeps env KEYS only and flags secret-looking names", () => {
    expect(app("blog").env).toEqual([{ key: "url" }, { key: "database__connection__password", secret: true }]);
  });
});

describe("caprover-map: one-click / image apps", () => {
  it("takes the image of the deployed version, not the newest one", () => {
    const d = defs()[0];
    expect(deployedImage({ ...d, deployedVersion: 1 })).toBe("ghost:5.1");
    expect(deployedImage(d)).toBe("ghost:5.2");
    expect(deployedImage({ ...d, deployedVersion: undefined })).toBe("ghost:5.2"); // newest when none is recorded
  });

  it("maps image, port, domain, volume and a persistent single replica", () => {
    const blog = app("blog");
    expect(blog).toMatchObject({
      kind: "image",
      buildPack: "image",
      image: "ghost:5.2",
      imageOrigin: "registry",
      ports: [2368],
      replicas: 1,
      internalHost: "srv-captain--blog",
      domains: [{ host: "blog.example.com", https: true, port: 2368, certType: "le-http", primary: true }],
      volumes: [{ name: "blog-content", mountPath: "/var/lib/ghost/content", type: "named", ownerRef: "blog" }],
    });
  });

  it("an app without a custom domain gets a note about the CapRover sub-domain, an unexposed one does not", () => {
    expect(app("uploader").domains).toEqual([]);
    expect(app("uploader").notCarried?.map((n) => n.reasonCode)).toContain("caprover_default_domain");
    expect(app("blog").notCarried).toBeUndefined();
  });
});

describe("caprover-map: git apps", () => {
  const api = () => app("api");

  it("maps the repository and branch to a dockerfile build, without any git credential", () => {
    expect(api()).toMatchObject({ kind: "git", buildPack: "dockerfile", imageOrigin: "built-from-git", git: { url: "https://github.com/acme/api", branch: "main", provider: "git" } });
    expect(api().image).toBeUndefined();
  });

  it("keeps the instance count, every custom domain (first is primary), and raw published ports", () => {
    expect(api().replicas).toBe(3);
    expect(api().domains).toEqual([
      { host: "api.example.com", https: true, port: 3000, certType: "le-http", primary: true },
      { host: "api.example.org", https: false, port: 3000, certType: "none", primary: false },
    ]);
    expect(api().ports).toEqual([3000, 9000]);
    expect(api().publishedPorts).toEqual([{ hostPort: 9000, containerPort: 9000, protocol: "tcp" }]);
  });

  it("reports what Tugra does not carry with fixed reasons", () => {
    const codes = (api().notCarried ?? []).map((n) => n.reasonCode);
    expect(codes).toEqual(expect.arrayContaining(["caprover_nginx_config", "caprover_captain_definition"]));
  });

  it("links the app to each database its env points at (sorted), and an app that names none gets no links", () => {
    expect(api().links).toEqual([
      { kind: "database", ref: "cache", envKey: "CACHE_HOST", internalHost: "srv-captain--cache" },
      { kind: "database", ref: "db", envKey: "DATABASE_URL", internalHost: "srv-captain--db" },
    ]);
    expect(app("blog").links).toBeUndefined();
  });

  it("does not link on a longer host that merely starts with a database name", () => {
    const d = { ...defs()[1], envVars: [{ key: "X", value: "http://srv-captain--db-admin:80" }] } as CaproverAppDefinition;
    const f = buildCaproverFleet({ definitions: [d, defs()[2]] });
    expect(f.apps[0].links).toBeUndefined();
  });

  it("repoUrl adds https to a host/path repo, strips embedded credentials and keeps scp-style urls", () => {
    expect(repoUrl("github.com/a/b")).toBe("https://github.com/a/b");
    expect(repoUrl("https://user:tok@github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(repoUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
    expect(repoUrl("  ")).toBeUndefined();
  });
});

describe("caprover-map: images built on the CapRover host", () => {
  it("an image with no repository is local-only: no pullable image, origin local, and a warning", () => {
    const up = app("uploader");
    expect(up).toMatchObject({ kind: "image", imageOrigin: "local", basicAuth: { users: ["admin"] }, volumes: [{ hostPath: "/srv/uploads", mountPath: "/data", type: "bind" }] });
    expect(up.image).toBeUndefined();
    expect(fleet().warnings.join(" ")).toMatch(/1 app\(s\) run an image built on the CapRover server/);
  });

  it("an image CapRover pushed to a registry keeps its name and reports the registry credential", () => {
    const d = { ...defs()[1], appPushWebhook: undefined, versions: [{ version: 7, deployedImageName: "registry.example.com/me/img-captain--api:7" }] } as CaproverAppDefinition;
    const a = mapApplication(d);
    expect(a).toMatchObject({ kind: "image", image: "registry.example.com/me/img-captain--api:7", imageOrigin: "registry" });
    expect(a.notCarried?.map((n) => n.reasonCode)).toContain("caprover_registry");
  });

  it("an app that was never deployed is left out with a warning", () => {
    expect(fleet().apps.map((a) => a.sourceRef)).not.toContain("draft");
    expect(fleet().warnings.join(" ")).toMatch(/1 app\(s\) were never deployed/);
  });
});

describe("caprover-map: databases", () => {
  it("recognises database images, with registry, tag and library prefix noise", () => {
    expect(caproverEngine("postgres:16-alpine")).toBe("POSTGRES");
    expect(caproverEngine("docker.io/library/mysql:8")).toBe("MYSQL");
    expect(caproverEngine("bitnami/mariadb:11")).toBe("MARIADB");
    expect(caproverEngine("mongo:7")).toBe("MONGO");
    expect(caproverEngine("redis")).toBe("REDIS");
    expect(caproverEngine("eqalpha/keydb")).toBe("KEYDB");
    expect(caproverEngine("ghcr.io/acme/postgres-backup:1")).toBeUndefined();
    expect(caproverEngine("img-captain--postgres:1")).toBeUndefined();
    expect(caproverEngine(undefined)).toBeUndefined();
  });

  it("maps a single-instance database image to a Tugra database with names only", () => {
    const f = fleet();
    expect(f.databases.map((d) => d.sourceRef).sort()).toEqual(["cache", "db"]);
    expect(f.databases.find((d) => d.sourceRef === "db")).toEqual({
      sourceRef: "db",
      name: "db",
      engine: "POSTGRES",
      version: "16",
      image: "postgres:16-alpine",
      credentials: { username: "app", database: "app", secretRef: "db" },
      hostInternal: "srv-captain--db",
      externalPort: 5432,
      volumes: [{ name: "db-data", mountPath: "/var/lib/postgresql/data", type: "named", ownerRef: "db" }],
    });
    expect(f.databases.find((d) => d.sourceRef === "cache")).toMatchObject({ engine: "REDIS", version: "7", credentials: { username: "default", secretRef: "cache" } });
    expect(f.apps.map((a) => a.sourceRef)).not.toContain("db");
  });

  it("keeps a multi-instance database image as an app", () => {
    expect(isDatabaseApp(defs()[6])).toBe(false);
    expect(fleet().apps.map((a) => a.sourceRef)).toContain("pg-pool");
  });

  it("reads the real credentials from the env, for the secret path only", () => {
    expect(dbCredentialsFromEnv(defs()[2])).toEqual({ user: "app", password: "DBPW_SENTINEL", rootPassword: undefined, database: "app" });
    expect(dbCredentialsFromEnv(defs()[3])).toBeUndefined(); // redis without a password: Tugra mints fresh credentials
    const mysql = { appName: "m", versions: [{ version: 1, deployedImageName: "mysql:8" }], deployedVersion: 1, envVars: [{ key: "MYSQL_ROOT_PASSWORD", value: "root-pw" }, { key: "MYSQL_DATABASE", value: "shop" }] } as unknown as CaproverAppDefinition;
    expect(dbCredentialsFromEnv(mysql)).toEqual({ user: "root", password: undefined, rootPassword: "root-pw", database: "shop" });
  });
});

describe("caprover-map: small mappers", () => {
  it("published ports: invalid rows are skipped, a repeated host binding collapses, udp is kept", () => {
    expect(
      mapPublishedPorts([
        { hostPort: 8080, containerPort: 80 },
        { hostPort: 8080, containerPort: 81 },
        { hostPort: 0, containerPort: 80 },
        { hostPort: 53, containerPort: 53, protocol: "UDP" },
      ]),
    ).toEqual([
      { hostPort: 8080, containerPort: 80, protocol: "tcp" },
      { hostPort: 53, containerPort: 53, protocol: "udp" },
    ]);
  });

  it("an app that is not exposed as a web app imports no domain and no web port", () => {
    const a = mapApplication({ appName: "worker", notExposeAsWebApp: true, customDomain: [{ publicDomain: "w.example.com", hasSsl: true }], versions: [{ version: 1, deployedImageName: "acme/worker:1" }], deployedVersion: 1 });
    expect(a.domains).toEqual([]);
    expect(a.ports).toEqual([]);
  });

  it("a fleet from an empty or malformed list is empty, not an error", () => {
    const f = buildCaproverFleet({ definitions: [null as never, { appName: "" } as never] });
    expect(f).toMatchObject({ apps: [], databases: [], servers: [], services: [], warnings: [] });
  });
});
