import { engineOfImage, judgeReady, mapNetworks, mapServiceMounts, memberViews, parseServiceCompose, sameNetworkRows, startOrder, type ComposeVolumeFacts, type MemberProbe, type ServiceMemberRecord } from "./inplace-service";

const vols: ComposeVolumeFacts[] = [
  { key: "data", dockerName: "tugra_app_data", external: false },
  { key: "uploads", dockerName: "tugra_app_uploads", external: false },
];

describe("parseServiceCompose", () => {
  it("reads images, both depends_on forms, named volumes, absolute binds and anonymous volumes; a relative bind is a config file and is none of them", () => {
    const c = parseServiceCompose(`
services:
  web:
    image: ghost:5
    depends_on: [db, cache]
    volumes:
      - data:/var/lib/ghost
      - /srv/up:/uploads:ro
      - ./nginx.conf:/etc/nginx.conf:ro
      - /scratch
  db:
    image: postgres:16
    depends_on:
      cache:
        condition: service_healthy
    volumes:
      - type: volume
        source: pg
        target: /var/lib/postgresql/data
      - type: bind
        source: /srv/db
        target: /db
      - type: tmpfs
        target: /tmp
  cache:
    build: .
`)!;
    expect(c.web).toEqual({ image: "ghost:5", dependsOn: ["db", "cache"], named: [{ source: "data", target: "/var/lib/ghost" }], binds: [{ source: "/srv/up", target: "/uploads" }], anonymous: ["/scratch"] });
    expect(c.db.dependsOn).toEqual(["cache"]);
    expect(c.db.named).toEqual([{ source: "pg", target: "/var/lib/postgresql/data" }]);
    expect(c.db.binds).toEqual([{ source: "/srv/db", target: "/db" }]);
    expect(c.cache.image).toBeNull(); // builds: nothing to reuse
  });
  it("is null for anything that is not a mapping of services", () => {
    expect(parseServiceCompose(null)).toBeNull();
    expect(parseServiceCompose("")).toBeNull();
    expect(parseServiceCompose("services: []")).toBeNull();
    expect(parseServiceCompose("services: {}")).toBeNull();
    expect(parseServiceCompose("a: [unterminated")).toBeNull();
    expect(parseServiceCompose("services:\n  web: nope")).toBeNull();
  });
});

describe("startOrder", () => {
  it("puts a service after what it depends on, ties by name", () => {
    const c = parseServiceCompose("services:\n  web:\n    image: a\n    depends_on: [db]\n  db:\n    image: b\n  alpha:\n    image: c\n")!;
    expect(startOrder(c)).toEqual(["alpha", "db", "web"]);
  });
  it("ignores a dependency that is not a service and survives a cycle", () => {
    const c = parseServiceCompose("services:\n  a:\n    image: x\n    depends_on: [ghost]\n  b:\n    image: x\n    depends_on: [c]\n  c:\n    image: x\n    depends_on: [b]\n")!;
    expect(startOrder(c)).toEqual(["a", "b", "c"]);
  });
});

describe("engineOfImage", () => {
  it.each([
    ["postgres:16", "POSTGRES"],
    ["docker.io/library/postgres:16-alpine", "POSTGRES"],
    ["postgis/postgis:16-3.4", "POSTGRES"],
    ["pgvector/pgvector:pg16", "POSTGRES"],
    ["mysql:8.4", "MYSQL"],
    ["mariadb:11", "MARIADB"],
    ["redis:7", "REDIS"],
    ["eqalpha/keydb", "KEYDB"],
    ["mongo:7@sha256:" + "a".repeat(64), "MONGO"],
    ["ghcr.io/dragonflydb/dragonfly:v1", "DRAGONFLY"],
    ["ghost:5", undefined],
    ["bitnami/postgresql:16", undefined],
  ])("%s is %s", (image, engine) => expect(engineOfImage(image)).toBe(engine));
});

describe("mapServiceMounts", () => {
  const svc = parseServiceCompose("services:\n  web:\n    image: x\n    volumes:\n      - data:/data\n      - /srv/up:/uploads\n")!.web;
  it("aliases a named volume mounted where the compose declares one; the data is shared when the mount is writable", () => {
    const m = mapServiceMounts([{ type: "volume", source: "u_data", destination: "/data", rw: true }], svc, vols);
    expect(m).toEqual({ volumes: [{ from: "u_data", to: "tugra_app_data", key: "data" }], binds: [], exclusive: true, issues: [] });
  });
  it("a read-only volume is aliased but shares nothing writable", () => {
    expect(mapServiceMounts([{ type: "volume", source: "u_data", destination: "/data", rw: false }], svc, vols).exclusive).toBe(false);
  });
  it("a host folder is carried by the compose volume the import made of it, or used as it is when the compose binds the same folder", () => {
    const m = mapServiceMounts([{ type: "bind", source: "/x/up", destination: "/data", rw: true }], svc, vols);
    expect(m.binds).toEqual([{ from: "/x/up", to: "tugra_app_data", key: "data" }]);
    const same = mapServiceMounts([{ type: "bind", source: "/srv/up", destination: "/uploads", rw: true }], svc, vols);
    expect(same).toMatchObject({ volumes: [], binds: [], exclusive: true, issues: [] });
    const other = mapServiceMounts([{ type: "bind", source: "/srv/elsewhere", destination: "/uploads", rw: true }], svc, vols);
    expect(other.issues).toEqual(["bind_unmapped"]);
  });
  it("a writable mount with no counterpart is an issue, a read-only one is a config file and is ignored; tmpfs and other are ignored", () => {
    expect(mapServiceMounts([{ type: "volume", source: "v", destination: "/nowhere", rw: true }], svc, vols).issues).toEqual(["volume_unmapped"]);
    expect(mapServiceMounts([{ type: "bind", source: "/a", destination: "/nowhere", rw: true }], svc, vols).issues).toEqual(["bind_unmapped"]);
    expect(mapServiceMounts([{ type: "volume", source: "v", destination: "/nowhere", rw: false }, { type: "bind", source: "/a", destination: "/b", rw: false }, { type: "tmpfs", source: "", destination: "/t", rw: true }, { type: "other", source: "x", destination: "/o", rw: true }], svc, vols)).toEqual({ volumes: [], binds: [], exclusive: false, issues: [] });
  });
  it("one compose volume cannot stand for two different Coolify sources", () => {
    const two = parseServiceCompose("services:\n  web:\n    image: x\n    volumes:\n      - data:/a\n      - data:/b\n")!.web;
    const m = mapServiceMounts([{ type: "volume", source: "one", destination: "/a", rw: true }, { type: "volume", source: "two", destination: "/b", rw: true }], two, vols);
    expect(m.issues).toEqual(["volume_unmapped"]);
    const same = mapServiceMounts([{ type: "volume", source: "one", destination: "/a", rw: true }, { type: "volume", source: "one", destination: "/b", rw: true }], two, vols);
    expect(same.issues).toEqual([]);
    expect(same.volumes).toHaveLength(1);
  });
  it("an anonymous volume in the compose where Coolify's container holds data is refused; where it holds nothing writable it is not", () => {
    const anon = parseServiceCompose("services:\n  web:\n    image: x\n    volumes:\n      - /var/lib/x\n")!.web;
    expect(mapServiceMounts([{ type: "volume", source: "h".repeat(64), destination: "/var/lib/x", rw: true }], anon, vols).issues).toEqual(["volume_unmapped"]);
    expect(mapServiceMounts([], anon, vols).issues).toEqual([]);
  });
  it("a service the compose does not declare maps nothing and refuses writable data", () => {
    expect(mapServiceMounts([{ type: "volume", source: "v", destination: "/d", rw: true }], undefined, vols).issues).toEqual(["volume_unmapped"]);
  });
});

describe("mapNetworks", () => {
  const ghost = { service: "ghost", container: { name: "ghost-abc123" }, networks: [{ name: "abc123", aliases: ["ghost", "0123456789ab", "extra"] }, { name: "coolify", aliases: ["ghost"] }, { name: "bridge", aliases: [] }] };
  it("carries the per-service network under the container name and its other aliases; the compose service name, the short id and the proxy and docker networks are left out", () => {
    const r = mapNetworks([ghost], [], "abc123");
    expect(r.issues).toEqual([]);
    expect(r.rows).toEqual([{ network: "abc123", service: "ghost", aliases: ["ghost-abc123", "extra"] }]);
  });
  it("merges into what the app has and never replaces it", () => {
    const r = mapNetworks([ghost], [{ network: "abc123", service: "ghost", aliases: ["mine"] }, { network: "private", service: "db", aliases: ["pg"] }], "abc123");
    expect(r.rows).toEqual([
      { network: "abc123", service: "ghost", aliases: ["mine", "ghost-abc123", "extra"] },
      { network: "private", service: "db", aliases: ["pg"] },
    ]);
  });
  it("the default network of the Coolify project and Tugra's own networks are not carried", () => {
    const r = mapNetworks([{ service: "a", container: { name: "a-u" }, networks: [{ name: "u_default", aliases: [] }, { name: "tugra-proxy", aliases: [] }, { name: "tugra_x_default", aliases: [] }] }], [], "u");
    expect(r).toEqual({ rows: [], issues: [] });
  });
  it("a network or alias name that cannot be carried, too many aliases and too many attachments are issues", () => {
    expect(mapNetworks([{ service: "a", container: { name: "a-u" }, networks: [{ name: "Odd_Net", aliases: [] }] }], [], "u").issues).toEqual(["service_networks_unmapped"]);
    expect(mapNetworks([{ service: "a", container: { name: "a-u" }, networks: [{ name: "net", aliases: ["bad_alias"] }] }], [], "u").issues).toEqual(["service_networks_unmapped"]);
    expect(mapNetworks([{ service: "a", container: { name: "a-u" }, networks: [{ name: "net", aliases: ["a1", "a2", "a3", "a4"] }] }], [], "u").issues).toEqual(["service_networks_unmapped"]);
    const many = Array.from({ length: 9 }, (_, i) => ({ service: `s${i}`, container: { name: `s${i}-u` }, networks: [{ name: "net", aliases: [] }] }));
    expect(mapNetworks(many, [], "u").issues).toEqual(["service_networks_unmapped"]);
  });
});

describe("sameNetworkRows", () => {
  it("compares as sets, alias order aside", () => {
    expect(sameNetworkRows([{ network: "n", service: "a", aliases: ["x", "y"] }], [{ network: "n", service: "a", aliases: ["y", "x"] }])).toBe(true);
    expect(sameNetworkRows([{ network: "n", service: "a", aliases: ["x"] }], [{ network: "n", service: "a", aliases: ["y"] }])).toBe(false);
    expect(sameNetworkRows([], [{ network: "n", service: "a", aliases: [] }])).toBe(false);
  });
});

describe("judgeReady", () => {
  const p = (service: string, over: Partial<MemberProbe> = {}): MemberProbe => ({ service, name: `${service}-1`, state: "running", health: "none", restarts: 0, ...over });
  const order = ["db", "web"];
  it("is ready only when every member ran and looked the same on the poll before", () => {
    const cur = [p("db", { health: "healthy" }), p("web")];
    expect(judgeReady(null, cur, order)).toEqual({ ready: false, notReady: ["db", "web"], dead: [] });
    expect(judgeReady(cur, cur, order)).toEqual({ ready: true, notReady: [], dead: [] });
  });
  it("a restart between two polls, a health check still starting or unhealthy, a missing member and a non-running state are not ready", () => {
    const prev = [p("db"), p("web")];
    expect(judgeReady(prev, [p("db", { restarts: 1 }), p("web")], order).notReady).toEqual(["db"]);
    expect(judgeReady(prev, [p("db", { health: "starting" }), p("web")], order).notReady).toEqual(["db"]);
    expect(judgeReady(prev, [p("db", { health: "unhealthy" }), p("web")], order).notReady).toEqual(["db"]);
    expect(judgeReady(prev, [p("db")], order).notReady).toEqual(["web"]);
    expect(judgeReady(prev, [p("db", { state: "restarting" }), p("web")], order).notReady).toEqual(["db"]);
  });
  it("an exited or dead container ends the wait and is named, in start order", () => {
    const r = judgeReady([p("db"), p("web")], [p("db"), p("web", { state: "exited" })], order);
    expect(r).toEqual({ ready: false, notReady: ["web"], dead: ["web"] });
    expect(judgeReady(null, [p("db", { state: "dead" }), p("web", { state: "exited" })], order).dead).toEqual(["db", "web"]);
  });
  it("a service with two containers needs both", () => {
    const cur = [p("web"), { ...p("web"), name: "web-2", state: "exited" }];
    expect(judgeReady(cur, cur, ["web"]).ready).toBe(false);
  });
});

describe("memberViews", () => {
  it("names, readiness and the database check only, no container", () => {
    const m: ServiceMemberRecord = { service: "db", container: { id: "a".repeat(64), name: "db-u", image: "postgres:16", restart: "always", imageId: `sha256:${"b".repeat(64)}` }, composeImage: "postgres:16", volumes: [], binds: [], engine: "POSTGRES", ready: "ok", dbVerify: { level: "counts", state: "ok" } };
    expect(memberViews([m, { ...m, service: "web", engine: undefined, dbVerify: undefined, ready: "failed" }])).toEqual([
      { name: "db", ready: "ok", verify: { level: "counts", state: "ok" } },
      { name: "web", ready: "failed" },
    ]);
  });
});
