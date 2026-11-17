// A Coolify API as the real estate presents it, in two profiles (buildFleet({ profile })): "4.1.2" (the default, the version the owner's
// inventory was taken on) and "4.7.5" (see the end of this header), generated from invented names (nothing here is a real project, host or
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
//
// The "4.7.5" profile keeps the same resources and changes what 4.7.5 changed (read from the 4.7.5 source, bootstrap/helpers/docker.php,
// routes/api.php, Api/*Controller.php, config/api.php):
//   - LIST rows carry no sensitive fields and no members: a service row has no applications[], databases[], server or docker_compose_raw
//     (they arrive on the detail GET); an application row has no `settings` (is_static / is_spa / custom_container_name_prefix live in
//     application_settings and appear only as `settings.*` on GET /applications/{uuid}); git applications carry `source_type`
//   - POST /{applications,databases,services}/{uuid}/{start,stop} exist (token ability `deploy`; an application start queues a deployment).
//     A database or service already in the asked state answers 400 "... is already running." / "... is already stopped."; GET on the same
//     path answers 405 "This endpoint has changed to a POST request." with `Allow: POST`
//   - every request of every token counts against ONE per-user budget (default 200 a minute, `rateLimit`); over it the answer is 429 with
//     `Retry-After` (seconds until the oldest counted request leaves the window)
//   - application container names are `<uuid>-YYYYMMDDTHHMMSS` (containerName(); the 4.1.2 form is `<uuid>-<12 digits>`)
import { createHash } from "node:crypto";

export const VERSION = "4.1.2";
export const VERSION_475 = "4.7.5";
export const PROFILES = [VERSION, VERSION_475];
// the fixed deploy moment the lab's container names carry (deterministic: selftest asserts exact names)
export const DEPLOYED_AT = new Date("2026-11-10T15:30:12Z");
export const RATE_LIMIT_PER_MINUTE = 200;
const RATE_WINDOW_MS = 60_000;
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
// containerName(profile, uuid[, at]): the container Coolify names after a deploy of application `uuid`. 4.1.2 .. 4.6: `<uuid>-<12 digits>`;
// 4.7.x: `<uuid>-YYYYMMDDTHHMMSS` (UTC here; bootstrap/helpers/docker.php generateApplicationContainerName).
export function containerName(profile, uuid, at = DEPLOYED_AT) {
  const iso = at.toISOString().replace(/[-:]/g, "").slice(0, 15); // 20261110T153012
  if (profile === VERSION_475) return `${uuid}-${iso}`;
  return `${uuid}-${iso.slice(2, 8)}${iso.slice(9, 15)}`; // 261110153012
}
export const tokenOf = (team) => `${team + 1}|labtoken${team}${uuid(`token:${team}`)}`;

export function buildFleet(opts = {}) {
  const profile = opts.profile ?? VERSION;
  if (!PROFILES.includes(profile)) throw new Error(`unknown Coolify profile ${profile}`);
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
        // 4.7.5 only (kept out of every 4.1.2 answer): the application_settings columns the API nests under `settings`
        settings: { is_static: nixpacks, is_spa: false, is_consistent_container_name_enabled: false, custom_container_name_prefix: null },
        source_type: image ? null : "App\\Models\\GithubApp",
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
  const running = new Map(teams.flatMap((t) => [...t.apps, ...t.databases, ...t.services].map((r) => [r.uuid, true])));
  const rate = profile === VERSION_475 ? { perMinute: opts.rateLimit ?? RATE_LIMIT_PER_MINUTE, hits: [] } : null;
  return { version: profile, profile, teams, running, rate, deployAbility: opts.deployAbility ?? true };
}

const strip = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)));

// what a 4.1.2 application answer never carries (the harness's own bindMount, and the 4.7.5-only settings / source_type)
const V412_APP_DROP = ["bindMount", "settings", "source_type"];
// the 4.7.5 list row of a service: identity only (members, server and the compose come with the detail GET)
const svcListRow = (sv) => strip(sv, ["applications", "databases", "server", "docker_compose_raw"]);
// the 4.7.5 detail of a service for a token without `read:sensitive`: members and server, no raw compose
const svcDetail = (sv) => strip(sv, ["docker_compose_raw"]);

// rateCheck(fleet, now) -> null, or the 429 answer: ALL tokens share ONE per-user budget (the real estate's eight team tokens belong to one user)
function rateCheck(fleet, now) {
  const r = fleet.rate;
  if (!r || !(r.perMinute > 0)) return null;
  r.hits = r.hits.filter((t) => now - t < RATE_WINDOW_MS);
  if (r.hits.length >= r.perMinute) {
    const retry = Math.max(1, Math.ceil((r.hits[0] + RATE_WINDOW_MS - now) / 1000));
    return { status: 429, body: { message: "Too Many Attempts." }, headers: { "Retry-After": String(retry) } };
  }
  r.hits.push(now);
  return null;
}

// action(fleet, kind, resource, verb) -> the 4.7.5 answer of POST /{kind}/{uuid}/{start|stop}
function action(fleet, kind, r, verb) {
  const up = fleet.running.get(r.uuid) !== false;
  if (kind === "applications") {
    // an application START queues a DEPLOYMENT (a rebuild), not a docker start; a stop of a stopped one is not an error
    fleet.running.set(r.uuid, verb === "start");
    return { status: 200, body: { message: verb === "start" ? "Deployment request queued." : "Application stopping request queued.", ...(verb === "start" ? { deployment_uuid: `dep${r.uuid.slice(0, 21)}` } : {}) } };
  }
  const noun = kind === "databases" ? "Database" : "Service";
  if (verb === "start" && up) return { status: 400, body: { message: `${noun} is already running.` } };
  if (verb === "stop" && !up) return { status: 400, body: { message: `${noun} is already stopped.` } };
  fleet.running.set(r.uuid, verb === "start");
  return { status: 200, body: { message: `${noun} ${verb === "start" ? "starting" : "stopping"} request queued.` } };
}

// route(fleet, method, path, token[, now]) -> { status, body, text?, headers? }: the API under /api/v1. `path` has no query string.
export function route(fleet, method, path, token, now = Date.now()) {
  const v475 = fleet.profile === VERSION_475;
  if (method !== "GET" && !(v475 && method === "POST")) return { status: 405, body: { message: "read-only" } };
  const team = fleet.teams.find((t) => t.token === token);
  if (!team) return { status: 401, body: { message: "Unauthenticated." } };
  if (v475) {
    const limited = rateCheck(fleet, now);
    if (limited) return limited;
  }
  const parts = path.replace(/^\/api\/v1/, "").split("/").filter(Boolean);
  const [kind, id, sub] = parts;
  if (method === "POST") {
    // 4.7.5: only the start / stop of a resource the token's team owns
    if (!["applications", "databases", "services"].includes(kind) || !["start", "stop"].includes(sub) || parts.length !== 3) return { status: 404, body: { message: "Not found." } };
    if (!fleet.deployAbility) return { status: 403, body: { message: "You are not allowed to perform this action." } };
    const list = kind === "applications" ? team.apps : kind === "databases" ? team.databases : team.services;
    const r = list.find((x) => x.uuid === id);
    return r ? action(fleet, kind, r, sub) : { status: 404, body: { message: `${kind === "applications" ? "Application" : kind === "databases" ? "Database" : "Service"} not found.` } };
  }
  if (v475 && ["applications", "databases", "services"].includes(kind) && (sub === "start" || sub === "stop") && parts.length === 3) {
    return { status: 405, body: { message: "This endpoint has changed to a POST request." }, headers: { Allow: "POST" } };
  }
  if (parts.length === 1 && parts[0] === "version") return { status: 200, text: fleet.version };
  // UNFILTERED: every token lists every team
  if (parts.length === 1 && parts[0] === "teams") return { status: 200, body: fleet.teams.map((t) => ({ id: t.id, name: t.name })) };
  if (parts.length === 1 && parts[0] === "servers") return { status: 200, body: team.servers.map((s) => strip(s, ["resources"])) };
  if (parts.length === 1 && parts[0] === "applications") return { status: 200, body: team.apps.map((a) => strip(a, v475 ? ["bindMount", "settings"] : V412_APP_DROP)) };
  if (parts.length === 1 && parts[0] === "databases") return { status: 200, body: team.databases };
  if (parts.length === 1 && parts[0] === "services") return { status: 200, body: v475 ? team.services.map(svcListRow) : team.services };
  if (kind === "servers" && sub === "resources") {
    const s = team.servers.find((x) => x.uuid === id);
    return s ? { status: 200, body: s.resources } : { status: 404, body: { message: "Server not found." } };
  }
  if (kind === "applications") {
    const a = team.apps.find((x) => x.uuid === id);
    if (!a) return { status: 404, body: { message: "Application not found." } };
    // the detail of a 4.7.5 application nests the settings; the 4.1.2 one does not carry them at all
    if (!sub) return { status: 200, body: strip(a, v475 ? ["bindMount"] : V412_APP_DROP) };
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
  if (v475 && kind === "services") {
    const sv = team.services.find((x) => x.uuid === id);
    if (!sv) return { status: 404, body: { message: "Service not found." } };
    if (!sub) return { status: 200, body: svcDetail(sv) };
  }
  return { status: 404, body: { message: "Not found." } };
}

// summary(fleet): what each team's token should see, for the scenario's assertions (no resource names)
export function summary(fleet) {
  return fleet.teams.map((t) => ({
    index: t.id, token: t.token, servers: t.servers.length, apps: t.apps.length, databases: t.databases.length, services: t.services.length,
    // the first application: the uuid a scenario can name a source container after, and the container name this version gives it
    ...(t.apps.length ? { firstApp: { uuid: t.apps[0].uuid, container: containerName(fleet.profile, t.apps[0].uuid) } } : {}),
  }));
}
