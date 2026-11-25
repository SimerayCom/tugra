import { computeExposed, ExposedServiceSchema } from "./server-scan-exposed";
import { buildScanReport, parseDockerScan, parseHostScan, ScanReportSchema, parseStoredReport, type DockerScan, type HostScanResult } from "./server-scan";

const NOW = new Date("2026-12-05T10:00:00Z");
const row = (name: string, image: string, ports = "", state = "running", project = "") =>
  JSON.stringify([`/${name}`, image, state, project, "", "", "", "", ports]);
const dockerOf = (...rows: string[]): DockerScan => parseDockerScan(["TUGRA_SCAN_DOCKER_BEGIN", ...rows, "TUGRA_SCAN_DOCKER_END"].join("\n"))!;
const hostOf = (ports: { port: number; scope: "public" | "local" }[]): HostScanResult =>
  parseHostScan(["TUGRA_SCAN_HOST_BEGIN", JSON.stringify({ v: 1, markers: [], pm2: [], sites: [], services: [], ports: ports.map((p) => ({ ...p, proto: "tcp" })) }), "TUGRA_SCAN_HOST_END"].join("\n"));
const pub = (...ports: number[]) => ports.map((port) => ({ port, scope: "public" as const }));

describe("computeExposed", () => {
  it("flags a database / cache published on every interface, by its image, whatever the port", () => {
    const published = new Map([
      [3306, { name: "blog-mysql", image: "mysql:8" }],
      [6482, { name: "cache", image: "redis:7" }],
      [49157, { name: "docs", image: "mongo:7" }],
      [50233, { name: "pg-a", image: "postgres:16" }],
      [25432, { name: "pg-b", image: "docker.io/library/postgres:15" }],
    ]);
    const out = computeExposed(pub(3306, 6482, 49157, 50233, 25432), published);
    expect(out.map((e) => [e.port, e.service, e.basis, e.container, e.fix])).toEqual([
      [6482, "Redis", "container", "cache", "publish_local"],
      [49157, "MongoDB", "container", "docs", "publish_local"],
      [3306, "MySQL", "container", "blog-mysql", "publish_local"],
      [25432, "PostgreSQL", "container", "pg-b", "publish_local"],
      [50233, "PostgreSQL", "container", "pg-a", "publish_local"],
    ]);
    expect(out[0].severity).toBe("critical");
    expect(out.find((e) => e.port === 3306)?.severity).toBe("high");
  });

  it("never flags a loopback / private listener", () => {
    const published = new Map([[6379, { name: "cache", image: "redis:7" }]]);
    expect(computeExposed([{ port: 6379, scope: "local" }, { port: 5432, scope: "local" }], published)).toEqual([]);
  });

  it("identifies an ownerless host service by its well-known port and says so", () => {
    const out = computeExposed(pub(5432, 27017, 11211), new Map());
    expect(out.map((e) => [e.port, e.basis, e.container, e.fix])).toEqual([
      [11211, "port", null, "bind_local"],
      [27017, "port", null, "bind_local"],
      [5432, "port", null, "bind_local"],
    ]);
  });

  it("treats the Docker API as critical with its own fix", () => {
    const [e] = computeExposed(pub(2375), new Map());
    expect(e).toMatchObject({ port: 2375, kind: "docker", severity: "critical", fix: "docker_api" });
  });

  it("flags admin UIs by image and ignores ordinary web apps, SSH and HTTP", () => {
    const published = new Map([
      [8081, { name: "pma", image: "phpmyadmin/phpmyadmin:5" }],
      [9443, { name: "pt", image: "portainer/portainer-ce:2.21" }],
      [3000, { name: "site", image: "ghcr.io/acme/site:1" }],
    ]);
    const out = computeExposed(pub(22, 80, 443, 3000, 8081, 9443), published);
    expect(out.map((e) => [e.port, e.kind])).toEqual([[8081, "admin"], [9443, "admin"]]);
  });

  it("does not guess: an unknown image on an unrelated port is not a finding", () => {
    expect(computeExposed(pub(8080), new Map([[8080, { name: "x", image: "foo/bar:1" }]]))).toEqual([]);
  });

  it("a custom image sitting on a well-known data-store port is flagged by port", () => {
    const [e] = computeExposed(pub(6379), new Map([[6379, { name: "mine", image: "acme/cache-fork:1" }]]));
    expect(e).toMatchObject({ basis: "port", container: "mine", service: "Redis" });
  });

  it("orders by severity then port and de-duplicates ports", () => {
    const out = computeExposed([...pub(3306, 6379, 3306)], new Map());
    expect(out.map((e) => e.port)).toEqual([6379, 3306]);
  });

  it("every finding passes its schema", () => {
    for (const e of computeExposed(pub(2375, 3306, 6379, 9200, 5672, 15672), new Map())) expect(ExposedServiceSchema.safeParse(e).success).toBe(true);
  });
});

describe("buildScanReport exposed section", () => {
  it("merges the container owner with the host's public ports", () => {
    const r = buildScanReport({
      docker: dockerOf(row("cache", "redis:7", "6482"), row("web", "nginx:1", "8080"), row("pgl", "postgres:16", "25432")),
      host: hostOf([{ port: 6482, scope: "public" }, { port: 8080, scope: "public" }, { port: 25432, scope: "local" }, { port: 3306, scope: "public" }]),
      now: NOW,
    });
    expect(r.exposed.map((e) => [e.port, e.service])).toEqual([[6482, "Redis"], [3306, "MySQL / MariaDB"]]);
    expect(ScanReportSchema.safeParse(r).success).toBe(true);
    expect(parseStoredReport(JSON.parse(JSON.stringify(r)))?.exposed).toEqual(r.exposed);
  });

  it("includes Tugra's own app databases when they are published publicly", () => {
    const r = buildScanReport({
      docker: dockerOf(row("tugra_db_cmabcdefghijklmnopqrstuv", "postgres:16", "55432")),
      host: hostOf([{ port: 55432, scope: "public" }]),
      now: NOW,
    });
    expect(r.exposed).toHaveLength(1);
  });

  it("has no findings without a host scan (no port data) and an old stored report parses with none", () => {
    const r = buildScanReport({ docker: dockerOf(row("cache", "redis:7", "6379")), host: { status: "unavailable", reason: "agent_outdated" }, now: NOW });
    expect(r.exposed).toEqual([]);
    const old = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
    delete old.exposed;
    expect(parseStoredReport(old)?.exposed).toEqual([]);
  });
});
