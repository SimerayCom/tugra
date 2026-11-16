// A Coolify 4.1.2 API as the real estate presents it, generated from invented names (nothing here is a real project, host or
// address; hostnames are example.test, addresses are the TEST-NET-1 documentation range). Pure: no I/O, importable from selftest.mjs.
//
// What it reproduces, because the importer and P7 discovery must cope with it:
//   - one READ-ONLY token per team (a token only sees its own team's resources), eight teams, two of them empty
//   - GET /teams is UNFILTERED: every token sees all eight teams, so it cannot be used as a scope
//   - 78 applications (74 Dockerfile-from-git, 3 image, 1 nixpacks) spread over the six populated teams, 29 databases (14 redis,
//     10 postgres, 5 mariadb), 19 services (7 meilisearch, 6 minio, 3 beszel, 1 signoz, 1 cloudflared, 1 gotenberg), 24 servers
//   - `fqdn` is a COMMA LIST with both schemes (`https://a.example.test,http://a.example.test`), seven applications have no domain
//     (workers), two applications bind-mount a host path
//   - service sub-applications carry their domain with a port (`https://x.example.test:8080`)
//   - environment variables come without values (a non-sensitive token), with a preview-deployment twin of every key
import { createHash } from "node:crypto";

export const VERSION = "4.1.2";
export const TEAMS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: i, name: `team-${i}` }));
// resources per team, in the proportions of the real estate
const APPS_PER_TEAM = [30, 14, 19, 8, 0, 0, 3, 4];
const SERVERS_PER_TEAM = [5, 4, 5, 4, 0, 0, 3, 3];
const DBS_PER_TEAM = [7, 6, 6, 4, 0, 0, 3, 3];
const SERVICES_PER_TEAM = [7, 4, 3, 2, 0, 0, 1, 2];
const SERVICE_TYPES = [...Array(7).fill("meilisearch"), ...Array(6).fill("minio"), ...Array(3).fill("beszel"), "signoz", "cloudflared", "gotenberg"];
const DB_TYPES = [...Array(14).fill("redis"), ...Array(10).fill("postgresql"), ...Array(5).fill("mariadb")];
const DB_IMAGE = { redis: "redis:7.2", postgresql: "postgres:18-alpine", mariadb: "mariadb:11" };
const SERVICE_IMAGE = {
  meilisearch: "getmeili/meilisearch:latest", minio: "minio/minio:RELEASE.2025-04-22T22-12-26Z", beszel: "henrygd/beszel:latest",
  signoz: "signoz/signoz:latest", cloudflared: "cloudflare/cloudflared:latest", gotenberg: "gotenberg/gotenberg:8",
};

const uuid = (label) => createHash("sha256").update(`coolify-fleet:${label}`).digest("hex").slice(0, 24);
const pad = (n, w = 2) => String(n).padStart(w, "0");
export const tokenOf = (team) => `${team + 1}|labtoken${team}${uuid(`token:${team}`)}`;

export function buildFleet() {
  const teams = TEAMS.map((t) => ({ ...t, token: tokenOf(t.id), servers: [], apps: [], databases: [], services: [] }));
  let appNo = 0;
  let dbNo = 0;
  let svcNo = 0;
  for (const t of teams) {
    for (let s = 0; s < SERVERS_PER_TEAM[t.id]; s++) {
      t.servers.push({ uuid: uuid(`server:${t.id}:${s}`), name: `t${t.id}-host-${pad(s + 1)}`, ip: `192.0.2.${(t.id * 10 + s) % 250 + 1}`, resources: [] });
    }
    const server = (i) => t.servers[i % t.servers.length];
    for (let a = 0; a < APPS_PER_TEAM[t.id]; a++, appNo++) {
      const image = appNo >= 74 && appNo < 77;
      const nixpacks = appNo === 77;
      const domainless = appNo % 11 === 5 && appNo < 74; // 7 workers without a domain
      const app = {
        uuid: uuid(`app:${appNo}`),
        name: `t${t.id}-app-${pad(a + 1)}`,
        build_pack: image ? "dockerimage" : nixpacks ? "nixpacks" : "dockerfile",
        git_repository: image ? "coollabsio/coolify" : `org-a/repo-${pad(appNo + 1, 3)}`,
        git_branch: "main",
        dockerfile_location: nixpacks || image ? null : "/Dockerfile",
        docker_registry_image_name: image ? "nginx" : null,
        docker_registry_image_tag: image ? "1.27" : null,
        ports_exposes: "3000",
        fqdn: domainless ? null : `https://app-${pad(appNo + 1, 3)}.example.test,http://app-${pad(appNo + 1, 3)}.example.test`,
        bindMount: appNo === 40 || appNo === 41 ? `/mnt/lab-bind-${appNo}` : null,
      };
      t.apps.push(app);
      server(a).resources.push({ uuid: app.uuid, type: "application", name: app.name });
    }
    for (let d = 0; d < DBS_PER_TEAM[t.id]; d++, dbNo++) {
      const type = DB_TYPES[dbNo % DB_TYPES.length];
      const db = {
        uuid: uuid(`db:${dbNo}`),
        name: `t${t.id}-${type}-${pad(d + 1)}`,
        database_type: `standalone-${type}`,
        image: DB_IMAGE[type],
        is_public: false,
        ...(type === "postgresql" ? { postgres_user: "app", postgres_db: "app" } : {}),
        ...(type === "mariadb" ? { mariadb_user: "app", mariadb_database: "app" } : {}),
      };
      t.databases.push(db);
      server(d).resources.push({ uuid: db.uuid, type: "database", name: db.name });
    }
    for (let v = 0; v < SERVICES_PER_TEAM[t.id]; v++, svcNo++) {
      const type = SERVICE_TYPES[svcNo % SERVICE_TYPES.length];
      const sv = server(v);
      const svc = {
        uuid: uuid(`svc:${svcNo}`),
        name: `t${t.id}-${type}-${pad(v + 1)}`,
        service_type: type,
        docker_compose_raw: `services:\n  ${type}:\n    image: ${SERVICE_IMAGE[type]}\n    volumes:\n      - ${type}-data:/data\nvolumes:\n  ${type}-data: {}\n`,
        applications: [{ uuid: uuid(`svc-app:${svcNo}`), name: type, fqdn: `https://svc-${pad(svcNo + 1)}.example.test:8080`, image: SERVICE_IMAGE[type] }],
        databases: [],
        server: { uuid: sv.uuid, name: sv.name },
      };
      t.services.push(svc);
      sv.resources.push({ uuid: svc.uuid, type: "service", name: svc.name });
    }
  }
  return { version: VERSION, teams };
}

const strip = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)));

// route(fleet, method, path, token) -> { status, body, text? }: the API under /api/v1. `path` has no query string.
export function route(fleet, method, path, token) {
  if (method !== "GET") return { status: 405, body: { message: "read-only" } };
  const team = fleet.teams.find((t) => t.token === token);
  if (!team) return { status: 401, body: { message: "Unauthenticated." } };
  const parts = path.replace(/^\/api\/v1/, "").split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "version") return { status: 200, text: fleet.version };
  // UNFILTERED: every token lists every team
  if (parts.length === 1 && parts[0] === "teams") return { status: 200, body: fleet.teams.map((t) => ({ id: t.id, name: t.name })) };
  if (parts.length === 1 && parts[0] === "servers") return { status: 200, body: team.servers.map((s) => strip(s, ["resources"])) };
  if (parts.length === 1 && parts[0] === "applications") return { status: 200, body: team.apps.map((a) => strip(a, ["bindMount"])) };
  if (parts.length === 1 && parts[0] === "databases") return { status: 200, body: team.databases };
  if (parts.length === 1 && parts[0] === "services") return { status: 200, body: team.services };
  const [kind, id, sub] = parts;
  if (kind === "servers" && sub === "resources") {
    const s = team.servers.find((x) => x.uuid === id);
    return s ? { status: 200, body: s.resources } : { status: 404, body: { message: "Server not found." } };
  }
  if (kind === "applications") {
    const a = team.apps.find((x) => x.uuid === id);
    if (!a) return { status: 404, body: { message: "Application not found." } };
    if (!sub) return { status: 200, body: strip(a, ["bindMount"]) };
    // values are absent: a read-only token is not a sensitive one. Every key has a preview-deployment twin.
    if (sub === "envs") return { status: 200, body: [{ key: "NODE_ENV", is_preview: false, is_runtime: true }, { key: "NODE_ENV", is_preview: true, is_runtime: true }, { key: "LOG_LEVEL", is_preview: false, is_runtime: true }] };
    if (sub === "storages") {
      return { status: 200, body: { persistent_storages: a.bindMount ? [{ name: null, mount_path: "/data", host_path: a.bindMount }] : [], file_storages: [] } };
    }
  }
  if (kind === "databases") {
    const d = team.databases.find((x) => x.uuid === id);
    if (!d) return { status: 404, body: { message: "Database not found." } };
    if (sub === "storages") return { status: 200, body: { persistent_storages: [{ name: `${d.uuid}-data`, mount_path: "/data", host_path: null }], file_storages: [] } };
  }
  return { status: 404, body: { message: "Not found." } };
}

// summary(fleet): what each team's token should see, for the scenario's assertions (no resource names)
export function summary(fleet) {
  return fleet.teams.map((t) => ({ index: t.id, token: t.token, servers: t.servers.length, apps: t.apps.length, databases: t.databases.length, services: t.services.length }));
}
