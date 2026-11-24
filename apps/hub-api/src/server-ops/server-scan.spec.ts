import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_SCAN_CONTAINERS,
  ScanReportSchema,
  buildDockerScanScript,
  buildHostScanScript,
  buildScanReport,
  parseDockerScan,
  parseHostScan,
  parseStoredReport,
  type DockerScan,
  type HostScanResult,
} from "./server-scan";
import { SOFTWARE, softwareForImage, softwareForUnit, imageSegments } from "./server-scan-software";

const NOW = new Date("2026-11-24T10:00:00Z");

/** One docker-probe row: [name, image, state, project, service, workingDir, coolifyManaged, tugraRole, "ports"]. */
const row = (name: string, image: string, state = "running", project = "", service = "", wd = "", coolify = "", role = "", ports = "") =>
  JSON.stringify([`/${name}`, image, state, project, service, wd, coolify, role, ports]);
const dockerOut = (...lines: string[]) => ["TUGRA_SCAN_DOCKER_BEGIN", ...lines, "TUGRA_SCAN_DOCKER_END"].join("\n");

describe("probe scripts", () => {
  it("the docker probe is a parameterless constant that never reads env or the full label set", () => {
    const s = buildDockerScanScript();
    expect(s).toBe(buildDockerScanScript());
    expect(s).toContain("docker inspect --format");
    expect(s).not.toMatch(/\.Config\.Env|\.Config\.Labels\}\}|\{\{json \.Config\}\}|\{\{json \.\}\}/);
    expect(s).toContain("head -n 251");
  });
  it("the host probe runs only the trusted agent image, read-only, capability-stripped, never privileged", () => {
    const s = buildHostScanScript();
    expect(s).toContain('IMG="$TUGRA_AGENT_IMAGE"');
    expect(s).toContain("--pull never");
    expect(s).toContain("-v /:/host:ro");
    expect(s).toContain("--read-only");
    expect(s).toContain("--cap-drop ALL");
    expect(s).toContain("--cap-add DAC_READ_SEARCH");
    expect(s).toContain("--security-opt no-new-privileges");
    expect(s).toContain("--entrypoint tugra-agent");
    expect(s).not.toMatch(/--privileged|docker\.sock|--cap-add (?!DAC_READ_SEARCH)|SYS_ADMIN/);
    expect(s).toContain("scan --root=/host --proc=/proc");
  });
});

describe("parseDockerScan", () => {
  it("null when the probe did not run; unavailable when docker is missing", () => {
    expect(parseDockerScan("")).toBeNull();
    expect(parseDockerScan("TUGRA_NO_DOCKER\n")).toEqual({ available: false });
  });
  it("parses rows, strips the leading slash and cleans fields", () => {
    const r = parseDockerScan(dockerOut(row("web-1", "nginx:1.27", "running", "shop", "web", "/srv/shop", "", "", "8080 8443 8080")))!;
    expect(r.available && r.rows[0]).toMatchObject({ name: "web-1", image: "nginx:1.27", state: "running", project: "shop", service: "web", workingDir: "/srv/shop", ports: [8080, 8443], coolifyManaged: false, tugraRole: false });
  });
  it("skips malformed lines, bad names, wrong arity and keeps the rest", () => {
    const r = parseDockerScan(dockerOut("not json", "[1,2]", row("-bad name", "x"), row("ok", "redis:7", "weird-state"), JSON.stringify({ a: 1 })))!;
    expect(r.available && r.rows.map((x) => [x.name, x.state])).toEqual([["ok", "unknown"]]);
  });
  it("flags truncation when the end marker is missing or the agent cut the output", () => {
    const cut = parseDockerScan("TUGRA_SCAN_DOCKER_BEGIN\n" + row("a", "x") + "\n…(truncated)")!;
    expect(cut.available && cut.truncated).toBe(true);
    const ok = parseDockerScan(dockerOut(row("a", "x")))!;
    expect(ok.available && ok.truncated).toBe(false);
  });
  it("caps rows at the container limit and says so", () => {
    const lines = Array.from({ length: MAX_SCAN_CONTAINERS + 5 }, (_, i) => row(`c${i}`, "x"));
    const r = parseDockerScan(dockerOut(...lines))!;
    expect(r.available && r.rows.length).toBe(MAX_SCAN_CONTAINERS);
    expect(r.available && r.truncated).toBe(true);
  });
  it("neutralises control characters in untrusted fields", () => {
    const r = parseDockerScan(dockerOut(JSON.stringify(["/n", "img\u001b[31m:1", "running", "proj\nx", "", "", "", "", ""])))!;
    expect(r.available && r.rows[0].image).not.toMatch(/\u001b/);
    expect(r.available && r.rows[0].project).toBe("proj x");
  });
});

const hostJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, markers: [], pm2: [], sites: [], services: [], ports: [], errors: [], ...over });
const hostOut = (json: string) => `TUGRA_SCAN_HOST_BEGIN\n${json}\nTUGRA_SCAN_HOST_END\n`;

describe("parseHostScan", () => {
  it("reports why the host part is unavailable", () => {
    expect(parseHostScan("TUGRA_SCAN_HOST_UNAVAILABLE reason=no-image\n")).toEqual({ status: "unavailable", reason: "no_image" });
    expect(parseHostScan("TUGRA_SCAN_HOST_BEGIN\nTUGRA_SCAN_HOST_FAILED rc=125\nTUGRA_SCAN_HOST_END")).toEqual({ status: "unavailable", reason: "failed" });
    expect(parseHostScan("")).toEqual({ status: "unavailable", reason: "failed" });
  });
  it("an agent image without the subcommand prints nothing: agent_outdated", () => {
    expect(parseHostScan("TUGRA_SCAN_HOST_BEGIN\n\nTUGRA_SCAN_HOST_END\n")).toEqual({ status: "unavailable", reason: "agent_outdated" });
  });
  it("rejects invalid json and a different schema version", () => {
    expect(parseHostScan(hostOut("{broken"))).toEqual({ status: "unavailable", reason: "failed" });
    expect(parseHostScan(hostOut(JSON.stringify({ v: 2 })))).toEqual({ status: "unavailable", reason: "failed" });
  });
  it("keeps valid rows and drops malformed ones instead of failing the whole report", () => {
    const r = parseHostScan(
      hostOut(
        hostJson({
          sites: [
            { server: "nginx", names: ["a.example.com"], kind: "php", ssl: true, php: "8.2" },
            { server: "nginx", names: [], kind: "php", ssl: true },
            { server: "iis", names: ["x"], kind: "php", ssl: true },
            "garbage",
          ],
          ports: [{ port: 80, proto: "tcp", scope: "public" }, { port: 70000, proto: "tcp", scope: "public" }, { port: 22, proto: "udp", scope: "public" }],
          pm2: [{ user: "deploy", daemon: true, procs: [{ name: "api", status: "online", envCount: 3, port: 3000 }, { name: "", status: "online" }, { name: "x", status: "weird" }] }],
          services: [{ unit: "nginx", kind: "web", enabled: true }, { unit: "bad unit!", kind: "web", enabled: true }],
        }),
      ),
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.data.sites.map((s) => s.names[0])).toEqual(["a.example.com"]);
    expect(r.data.ports).toEqual([{ port: 80, proto: "tcp", scope: "public" }]);
    expect(r.data.pm2[0].procs.map((p) => p.name)).toEqual(["api"]);
    expect(r.data.services.map((s) => s.unit)).toEqual(["nginx"]);
  });
  it("never carries unknown fields (an env map smuggled into a pm2 row is dropped)", () => {
    const r = parseHostScan(hostOut(hostJson({ pm2: [{ user: "root", daemon: false, procs: [{ name: "api", status: "online", env: { SECRET: "hunter2" }, envCount: 1 }] }] })));
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });
});

describe("softwareForImage", () => {
  it.each([
    ["postgres:16", "postgres"],
    ["bitnami/postgresql:15", "postgres"],
    ["docker.io/library/redis:7-alpine", "redis"],
    ["ghcr.io/valkey-io/valkey:8", "valkey"],
    ["mongo:7", "mongo"],
    ["getmeili/meilisearch:v1.9", "meilisearch"],
    ["quay.io/minio/minio", "minio"],
    ["clickhouse/clickhouse-server:24", "clickhouse"],
    ["traefik:v3.1", "traefik"],
    ["ghcr.io/coollabsio/coolify:4.0.0-beta", "coolify"],
    ["dokploy/dokploy:latest", "dokploy"],
    ["ghcr.io/immich-app/immich-server:release", "immich"],
    ["vaultwarden/server:latest", "vaultwarden"],
    ["louislam/uptime-kuma:1", "uptime-kuma"],
    ["portainer/portainer-ce:2.21", "portainer"],
    ["n8nio/n8n", "n8n"],
  ])("%s -> %s", (image, id) => {
    expect(softwareForImage(image)?.id).toBe(id);
  });
  it("returns null for an unknown image instead of guessing", () => {
    expect(softwareForImage("registry.example.com/acme/billing-api:3")).toBeNull();
    expect(softwareForImage("")).toBeNull();
    expect(softwareForImage("coollabsio/some-other-thing")).toBeNull();
  });
  it("template matches bring the template name and logo; registry entries bring their own", () => {
    expect(softwareForImage("n8nio/n8n")).toMatchObject({ kind: "app", label: expect.any(String), logo: expect.any(String) });
    expect(softwareForImage("postgres:16")).toMatchObject({ label: "PostgreSQL", kind: "database", logo: "postgresql" });
  });
  it("imageSegments drops registry, tag and digest", () => {
    expect(imageSegments("ghcr.io/Acme/App:1.2@sha256:abc")).toEqual(["acme", "app"]);
    expect(imageSegments("localhost:5000/team/x")).toEqual(["team", "x"]);
  });
  it("maps systemd units", () => {
    expect(softwareForUnit("mysql")).toBe("mysql");
    expect(softwareForUnit("php8.2-fpm")).toBe("php");
    expect(softwareForUnit("pm2-deploy")).toBe("pm2");
    expect(softwareForUnit("ssh")).toBeNull();
  });
  it("every logo the registry names exists in the vendored icon set", () => {
    const dir = join(__dirname, "../../../web/public/icons");
    if (!existsSync(dir)) return;
    const have = new Set(readdirSync(dir).map((f) => f.replace(/\.svg$/, "")));
    const missing = Object.entries(SOFTWARE).filter(([, d]) => d.logo && !have.has(d.logo)).map(([id]) => id);
    expect(missing).toEqual([]);
  });
});

const dockerAvail = (rows: string[], truncated = false): DockerScan => {
  const p = parseDockerScan(dockerOut(...rows) + (truncated ? "\n…(truncated)" : ""));
  if (!p) throw new Error("fixture");
  return p;
};
const hostOk = (over: Record<string, unknown> = {}): HostScanResult => {
  const r = parseHostScan(hostOut(hostJson(over)));
  if (r.status !== "ok") throw new Error("fixture");
  return r;
};
const NO_HOST: HostScanResult = { status: "unavailable", reason: "agent_outdated" };

describe("buildScanReport", () => {
  it("hides Tugra's own containers and counts them", () => {
    const docker = dockerAvail([
      row("tugra-proxy", "traefik:v3", "running"),
      row("tugra-agent", "ghcr.io/simeraycom/tugra-agent:0.1", "running"),
      row("tugra_db_cmabcdefghijklmnopqrstuv", "postgres:16"),
      row("hub-api-1", "ghcr.io/simeraycom/tugra-hub-api:0.1", "running", "tugra", "hub-api", "/opt/tugra"),
      row("tugra-postgres-1", "postgres:16", "running", "tugra", "postgres", "/opt/tugra"),
      row("blog-db", "mariadb:11", "running", "", "", "", "", "", "3306"),
    ]);
    const r = buildScanReport({ docker, host: NO_HOST, now: NOW });
    expect(r.containers.map((c) => c.name)).toEqual(["blog-db"]);
    expect(r.docker).toMatchObject({ available: true, total: 6, tugra: 5, truncated: false });
  });

  it("builds the software strip with counts, logos and kind order", () => {
    const docker = dockerAvail([
      row("pg-a", "postgres:16"),
      row("pg-b", "postgres:15", "exited"),
      row("cache", "redis:7"),
      row("cache2", "redis:7"),
      row("photos", "ghcr.io/immich-app/immich-server:release"),
      row("mystery", "acme/billing:1"),
    ]);
    const r = buildScanReport({ docker, host: NO_HOST, now: NOW });
    const byId = Object.fromEntries(r.software.map((s) => [s.id, s]));
    expect(byId.postgres).toMatchObject({ label: "PostgreSQL", count: 2, logo: "postgresql", kind: "database", containers: ["pg-a", "pg-b"] });
    expect(byId.redis.count).toBe(2);
    expect(byId.immich.kind).toBe("app");
    expect(byId.docker).toMatchObject({ kind: "runtime", count: 5 }); // running containers
    expect(r.software.map((s) => s.kind)).toEqual([...r.software.map((s) => s.kind)].sort((a, b) => ["platform", "panel", "runtime", "web", "database", "app", "tool"].indexOf(a) - ["platform", "panel", "runtime", "web", "database", "app", "tool"].indexOf(b)));
    expect(r.containers.find((c) => c.name === "mystery")?.software).toBeNull();
  });

  it("recognises Coolify by label, by name and by its image, and keeps it from being adopted", () => {
    const docker = dockerAvail([
      row("coolify", "ghcr.io/coollabsio/coolify:4"),
      row("coolify-proxy", "traefik:v3.1"),
      row("abc123-1234", "node:22", "running", "abc123", "app", "", "true"),
      row("loose", "nginx:1"),
    ]);
    const r = buildScanReport({ docker, host: hostOk({ markers: ["coolify"] }), now: NOW });
    const coolify = r.software.find((s) => s.id === "coolify")!;
    expect(coolify.count).toBe(3); // the marker does not add a fourth
    expect(coolify.kind).toBe("platform");
    expect(r.containers.find((c) => c.name === "abc123-1234")).toMatchObject({ managedBy: "coolify", adoptable: false });
    expect(r.containers.find((c) => c.name === "loose")).toMatchObject({ managedBy: null, adoptable: true });
    expect(r.containers.find((c) => c.name === "coolify-proxy")).toMatchObject({ software: "traefik", managedBy: "coolify" });
  });

  it("compose members are not adoptable and are grouped by project", () => {
    const docker = dockerAvail([row("shop-web-1", "nginx", "running", "shop", "web"), row("shop-db-1", "mysql:8", "exited", "shop", "db"), row("shop-web-2", "nginx", "running", "shop", "web")]);
    const r = buildScanReport({ docker, host: NO_HOST, now: NOW });
    expect(r.containers.every((c) => !c.adoptable)).toBe(true);
    expect(r.composeProjects).toEqual([{ name: "shop", services: 2, running: 2 }]);
  });

  it("merges host facts: PM2, CloudPanel, nginx sites, services and ports with owners", () => {
    const host = hostOk({
      markers: ["cloudpanel", "nginx", "pm2", "tailscale"],
      pm2: [{ user: "deploy", daemon: true, procs: [{ name: "api", status: "online" }, { name: "worker", status: "stopped" }] }],
      sites: [
        { server: "nginx", names: ["a.example.com"], kind: "php", ssl: true, panel: "cloudpanel", php: "8.2" },
        { server: "nginx", names: ["b.example.com"], kind: "proxy", port: 3000, ssl: true, panel: "cloudpanel" },
      ],
      services: [{ unit: "php8.2-fpm", kind: "php", enabled: true, running: true }, { unit: "mysql", kind: "database", enabled: true, running: true }],
      ports: [{ port: 22, proto: "tcp", scope: "public" }, { port: 8080, proto: "tcp", scope: "public" }, { port: 3000, proto: "tcp", scope: "local" }, { port: 9999, proto: "tcp", scope: "public" }],
    });
    const docker = dockerAvail([row("web", "nginx:1", "running", "", "", "", "", "", "8080")]);
    const r = buildScanReport({ docker, host, now: NOW });
    const byId = Object.fromEntries(r.software.map((s) => [s.id, s]));
    expect(byId.cloudpanel).toMatchObject({ kind: "panel", count: 2 });
    expect(byId.pm2.count).toBe(2);
    expect(byId.tailscale.kind).toBe("tool");
    expect(byId.php.count).toBe(1);
    expect(byId.mysql).toMatchObject({ kind: "database", logo: "mysql" });
    expect(byId.nginx.count).toBe(3); // 1 container + 2 host vhosts
    expect(r.ports.find((p) => p.port === 8080)?.owner).toBe("web");
    expect(r.ports.find((p) => p.port === 22)?.owner).toBe("SSH");
    expect(r.ports.find((p) => p.port === 9999)?.owner).toBeNull();
    expect(r.pm2[0].procs).toHaveLength(2);
    expect(r.host).toEqual({ status: "ok", reason: null });
  });

  it("a host-only scan (no docker) still reports the host, and says docker is unavailable", () => {
    const r = buildScanReport({ docker: { available: false }, host: hostOk({ markers: ["nginx"] }), now: NOW });
    expect(r.docker).toMatchObject({ available: false, total: 0 });
    expect(r.software.map((s) => s.id)).toEqual(["nginx"]);
  });

  it("reports why the host part is missing", () => {
    const r = buildScanReport({ docker: dockerAvail([row("a", "redis:7")]), host: NO_HOST, now: NOW });
    expect(r.host).toEqual({ status: "unavailable", reason: "agent_outdated" });
    expect(r.pm2).toEqual([]);
  });

  it("produces a report that passes its own schema and round-trips through storage", () => {
    const r = buildScanReport({ docker: dockerAvail([row("a", "redis:7", "running", "", "", "", "", "", "6379")]), host: hostOk({ markers: ["nginx"], ports: [{ port: 6379, proto: "tcp", scope: "public" }] }), now: NOW });
    expect(ScanReportSchema.safeParse(r).success).toBe(true);
    expect(parseStoredReport(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(r.scannedAt).toBe(NOW.toISOString());
  });

  it("stores no env values or secrets whatever the agent sent", () => {
    const host = parseHostScan(hostOut(hostJson({ pm2: [{ user: "root", daemon: true, procs: [{ name: "api", status: "online", env: { TOKEN: "s3cr3t" }, envCount: 1 }] }] })));
    const r = buildScanReport({ docker: null, host, now: NOW });
    expect(JSON.stringify(r)).not.toContain("s3cr3t");
  });
});

describe("parseStoredReport", () => {
  it("a corrupt or old-shape row degrades to null", () => {
    expect(parseStoredReport(null)).toBeNull();
    expect(parseStoredReport({ v: 0 })).toBeNull();
    expect(parseStoredReport("x")).toBeNull();
  });
});
