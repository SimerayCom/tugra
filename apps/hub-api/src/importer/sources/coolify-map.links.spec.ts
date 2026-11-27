import { buildCoolifyFleet, mapDatabase, versionFromImage } from "./coolify-map";
import { planImport } from "../import-planner";

const DB = "dbuuid000000000000000001";
const SVC = "svcuuid00000000000000001";
const WEB = "webuuid00000000000000001";
const OTHER = "othuuid00000000000000001";

const servers = [{ uuid: "s-a", name: "a" }, { uuid: "s-b", name: "b" }] as never;
const app = (uuid: string, name: string) => ({ uuid, name, build_pack: "nixpacks", git_repository: "o/r" });
const pg = { uuid: DB, name: "main-db", database_type: "standalone-postgresql", image: "postgres:16" };
const svc = { uuid: SVC, name: "minio", service_type: "minio", docker_compose_raw: "services:\n  minio:\n    image: minio/minio\n", applications: [{ uuid: "m1", name: "minio" }], databases: [] };

const build = (over: Record<string, unknown> = {}) =>
  buildCoolifyFleet({
    servers,
    resourcesByServer: { "s-a": [WEB, OTHER], "s-b": [DB, SVC] },
    apps: [app(WEB, "web"), app(OTHER, "other")],
    databases: [pg],
    services: [svc as never],
    envsByResource: {},
    volumesByResource: {},
    ...over,
  });

describe("Coolify app dependency links (the scope step's 'Add them')", () => {
  it("an app whose variable names a database uuid or a service uuid is linked to it, and the plan makes them its dependencies", () => {
    const f = build({
      envsByResource: {
        [WEB]: [
          { key: "DATABASE_URL", value: `postgres://u:p@${DB}:5432/app` },
          { key: "S3_ENDPOINT", value: `http://minio-${SVC}:9000` },
        ],
        [OTHER]: [{ key: "PLAIN", value: "hello" }],
      },
    });
    const web = f.apps.find((a) => a.sourceRef === WEB)!;
    expect(web.links).toEqual([
      { kind: "database", ref: DB, envKey: "DATABASE_URL", internalHost: DB },
      { kind: "service", ref: SVC, envKey: "S3_ENDPOINT", internalHost: SVC },
    ]);
    expect(f.apps.find((a) => a.sourceRef === OTHER)!.links).toBeUndefined(); // readable and names nothing: no link
    const plan = planImport(f, { sourceKind: "coolify" });
    expect(plan.items.find((i) => i.itemRef === `app:s-a:${WEB}`)!.dependsOn).toEqual([`database:s-b:${DB}`, `service:s-b:${SVC}`]);
    expect(plan.items.find((i) => i.itemRef === `app:s-a:${OTHER}`)!.dependsOn).toEqual([]);
  });

  it("the real_value (shared references resolved) is read before the raw value", () => {
    const f = build({ envsByResource: { [WEB]: [{ key: "DATABASE_URL", value: "{{project.DB_URL}}", real_value: `postgres://u:p@${DB}:5432/app`, is_shared: true }] } });
    expect(f.apps.find((a) => a.sourceRef === WEB)!.links).toEqual([{ kind: "database", ref: DB, envKey: "DATABASE_URL", internalHost: DB }]);
  });

  it("no value is ever carried into the fleet by the link scan", () => {
    const f = build({ envsByResource: { [WEB]: [{ key: "DATABASE_URL", value: `postgres://u:SECRETPW@${DB}:5432/app` }] } });
    expect(JSON.stringify(f)).not.toContain("SECRETPW");
  });

  it("variables that cannot be read fall back to the databases and services of the app's own environment", () => {
    const loc = (env: string) => ({ projectRef: "p1", environmentRef: env });
    const f = build({
      envsByResource: { [WEB]: [{ key: "DATABASE_URL" }], [OTHER]: [{ key: "X" }] }, // no value: a read-only token or no consent yet
      locByUuid: new Map([[WEB, loc("p1#1")], [OTHER, loc("p1#2")], [DB, loc("p1#1")], [SVC, loc("p1#2")]]),
    });
    expect(f.apps.find((a) => a.sourceRef === WEB)!.links).toEqual([{ kind: "database", ref: DB }]);
    expect(f.apps.find((a) => a.sourceRef === OTHER)!.links).toEqual([{ kind: "service", ref: SVC }]);
  });

  it("an unexpanded shared reference cannot rule a dependency out: the environment fallback applies", () => {
    const f = build({
      envsByResource: { [WEB]: [{ key: "DATABASE_URL", value: "{{project.DB_URL}}", is_shared: true }] },
      locByUuid: new Map([[WEB, { projectRef: "p1", environmentRef: "p1#1" }], [DB, { projectRef: "p1", environmentRef: "p1#1" }]]),
    });
    expect(f.apps.find((a) => a.sourceRef === WEB)!.links).toEqual([{ kind: "database", ref: DB }]);
  });

  it("readable variables are authoritative: the same environment alone does not link", () => {
    const f = build({
      envsByResource: { [WEB]: [{ key: "A", value: "1" }] },
      locByUuid: new Map([[WEB, { projectRef: "p1", environmentRef: "p1#1" }], [DB, { projectRef: "p1", environmentRef: "p1#1" }]]),
    });
    expect(f.apps.find((a) => a.sourceRef === WEB)!.links).toBeUndefined();
  });

  it("two apps pointing at each other are not ordered on each other (an app link never becomes a dependency)", () => {
    const f = build({ envsByResource: { [WEB]: [{ key: "API", value: `http://${OTHER}:3000` }], [OTHER]: [{ key: "API", value: `http://${WEB}:3000` }] } });
    const plan = planImport(f, { sourceKind: "coolify" });
    expect(plan.items.filter((i) => i.kind === "app").every((i) => i.dependsOn.length === 0)).toBe(true);
  });
});

describe("a custom PostgreSQL image keeps a PostgreSQL major as its version", () => {
  it.each([
    ["pgvector/pgvector:0.8.0-pg16", "16"],
    ["timescale/timescaledb:2.17.2-pg16", "16"],
    ["timescale/timescaledb-ha:pg17", "17"],
    ["pgvector/pgvector:pg16", "16"],
    ["postgres:17-alpine", "17"],
    ["postgis/postgis:16-3.4", "16"],
    ["registry.example.com:5000/postgres:16", "16"],
  ])("%s -> %s", (image, major) => {
    expect(versionFromImage(image, "POSTGRES")).toBe(major);
  });

  it("an extension image with no pgNN tag has no readable major: no version is claimed, the plan asks for one", () => {
    expect(versionFromImage("ankane/pgvector:v0.5.1", "POSTGRES")).toBeUndefined();
    expect(versionFromImage("pgvector/pgvector:0.8.0", "POSTGRES")).toBeUndefined();
    const db = mapDatabase({ uuid: DB, name: "v", database_type: "standalone-postgresql", image: "pgvector/pgvector:0.8.0" } as never, { volumes: [] });
    expect(db.version).toBeUndefined();
    expect(db.image).toBe("pgvector/pgvector:0.8.0");
  });

  it("the plan names the PostgreSQL major, not the extension's version", () => {
    const f = build({ databases: [{ ...pg, image: "pgvector/pgvector:0.8.0-pg16" }] });
    expect(f.databases[0].version).toBe("16");
    const item = planImport(f, { sourceKind: "coolify", dbDataModes: { [`database:s-b:${DB}`]: "volume" } }).items.find((i) => i.kind === "database")!;
    expect(item.proposed).toMatchObject({ version: "16", image: "pgvector/pgvector:0.8.0-pg16" });
    expect(item.risks.map((r) => r.code)).not.toContain("db.version.missing");
    expect(item.risks.find((r) => r.code === "db.volume.locked")!.message).toContain("major 16");
  });

  it("other engines keep the first version in the tag", () => {
    expect(versionFromImage("redis:7.2", "REDIS")).toBe("7.2");
    expect(versionFromImage("mysql:8.0", "MYSQL")).toBe("8.0");
  });
});
