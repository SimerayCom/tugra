#!/usr/bin/env node
// Migration lab seeding (plain Node >= 22, stdlib + the hub's own @prisma/client). Creates, through the hub's REST API
// wherever a public route exists, a lab user/team/server/app/database, and through prisma the one thing no API creates
// without a real Coolify source: the import BulkOperation + its DONE provisioning task + the migration token (exactly
// what every hub spec does with a prisma insert).
//
//   seed.mjs base                       user + team + server + enroll token + capabilities; prints KEY=VALUE lines
//   seed.mjs server --name N --prefix P an extra server (a second agent); prints P_SERVER_ID / P_ENROLL_TOKEN
//   seed.mjs token                      a fresh access token (stdout)
//   seed.mjs server-status [id]         ONLINE | OFFLINE | PENDING
//   seed.mjs op --name N --source REF [--kind app|db] [--image I] [--version V] [--volume data] [--path /var/www/data]
//               [--server-id ID] [--no-credentials]   an import op + token; prints KEY=VALUE lines
//   seed.mjs transfer OP_ID             "STATE PARTS_DONE ERROR ATTEMPT" of the op's volume transfer(s)
//   seed.mjs db-status DB_ID            the Database row's status/image/version (for the L6 gates)
//   seed.mjs db-set DB_ID STATUS        force the Database row's status (L6: a started destination must be refused)
//   seed.mjs app --name N [--volume data] [--path P] [--server-id ID]   a plain app (no op), for the L8 app move
//
// Environment: LAB_DIR (state dir, default $TMPDIR/tugra-lab), LAB_HUB_PORT (3000), DATABASE_URL (default: read from
// $LAB_DIR/hub.env). The lab user and server ids persist in $LAB_DIR/lab.env.
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const labDir = process.env.LAB_DIR || join(process.env.TMPDIR || "/tmp", "tugra-lab");

function loadEnvFile(file, only) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || (only && !only.includes(m[1])) || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2];
  }
}
loadEnvFile(join(labDir, "hub.env"), ["DATABASE_URL", "LAB_HUB_PORT", "HUB_PORT"]);
loadEnvFile(join(labDir, "lab.env"));

const port = process.env.LAB_HUB_PORT || process.env.HUB_PORT || "3000";
const hub = process.env.LAB_HUB_LOCAL || `http://127.0.0.1:${port}`;
const USER_EMAIL = process.env.USER_EMAIL || "lab@tugra.test";
const USER_PASSWORD = process.env.USER_PASSWORD || "lab-password-0123456789";

const argv = process.argv.slice(2);
const cmd = argv.shift();
function flags(spec) {
  const out = { ...spec };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { (out._ ||= []).push(a); continue; }
    const k = a.slice(2);
    if (typeof spec[k] === "boolean") out[k] = true;
    else if (k in spec) out[k] = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

async function api(method, path, body, token) {
  const res = await fetch(`${hub}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json, text };
}
function must(r, ok, what) {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

let prismaClient;
async function prisma() {
  if (prismaClient) return prismaClient;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (and $LAB_DIR/hub.env has none)");
  const require = createRequire(join(root, "apps/hub-api/package.json"));
  const { PrismaClient } = require("@prisma/client");
  prismaClient = new PrismaClient();
  return prismaClient;
}

async function login() {
  let r = await api("POST", "/auth/login", { email: USER_EMAIL, password: USER_PASSWORD });
  if (r.status === 200 && r.json?.tokens?.accessToken) return { token: r.json.tokens.accessToken, userId: subOf(r.json.tokens.accessToken) };
  const reg = { email: USER_EMAIL, password: USER_PASSWORD, name: "Lab" };
  if (process.env.LAB_SETUP_CODE) reg.setupCode = process.env.LAB_SETUP_CODE;
  r = await api("POST", "/auth/register", reg);
  const j = must(r, [201], "register the lab user");
  return { token: j.tokens.accessToken, userId: j.user?.id ?? subOf(j.tokens.accessToken) };
}

// the login response carries no user object: the access token's `sub` is the user id
function subOf(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).sub;
}

const kv = (k, v) => console.log(`${k}=${v}`);
const ALL_CAPS = ["deploy", "database", "backup", "cleanup", "bulk", "schedule", "patch", "logs"]; // no terminal/swarm/files

async function teamOf(db, userId) {
  const m = await db.membership.findFirst({ where: { userId }, orderBy: { id: "asc" } });
  if (!m) throw new Error("the lab user has no team");
  return m.teamId;
}

async function createServer(token, teamId, name) {
  const j = must(await api("POST", "/servers", { name, teamId }, token), [201], "create the server");
  const db = await prisma();
  await db.server.update({ where: { id: j.server.id }, data: { capabilities: ALL_CAPS } });
  return { id: j.server.id, enrollToken: j.enrollToken };
}

async function main() {
  switch (cmd) {
    case "base": {
      const { token, userId } = await login();
      const db = await prisma();
      const teamId = await teamOf(db, userId);
      const s = await createServer(token, teamId, "lab-target");
      kv("USER_EMAIL", USER_EMAIL);
      kv("USER_PASSWORD", USER_PASSWORD);
      kv("USER_ID", userId);
      kv("TEAM_ID", teamId);
      kv("SERVER_ID", s.id);
      kv("ENROLL_TOKEN", s.enrollToken);
      break;
    }
    case "server": {
      const f = flags({ name: "lab-b", prefix: "B" });
      const { token, userId } = await login();
      const db = await prisma();
      const s = await createServer(token, await teamOf(db, userId), f.name);
      kv(`${f.prefix}_SERVER_ID`, s.id);
      kv(`${f.prefix}_ENROLL_TOKEN`, s.enrollToken);
      break;
    }
    case "token": {
      process.stdout.write((await login()).token);
      break;
    }
    case "server-status": {
      const id = argv[0] || process.env.SERVER_ID;
      const db = await prisma();
      const s = await db.server.findUnique({ where: { id }, select: { status: true } });
      console.log(s ? s.status : "MISSING");
      break;
    }
    case "op": {
      const f = flags({ name: `lab-${Date.now()}`, source: "labsrc", kind: "app", image: "", version: "16", volume: "data", path: "/var/www/data", "server-id": "", "no-credentials": false });
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(f.source)) throw new Error("bad --source");
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.volume)) throw new Error("bad --volume");
      const serverId = f["server-id"] || process.env.SERVER_ID;
      const { token, userId } = await login();
      const db = await prisma();
      const server = await db.server.findUnique({ where: { id: serverId } });
      if (!server) throw new Error(`server ${serverId} not found`);
      const ownerRef = `${f.kind === "db" ? "database" : "app"}:_:${f.source}`;
      const items = [];
      let resourceId;
      let result;
      let destVolume;
      if (f.kind === "db") {
        const d = must(await api("POST", "/databases", { name: f.name, serverId, engine: "POSTGRES", version: f.version }, token), [201], "create the database");
        resourceId = d.id;
        // the destination runs the SAME image as the source when asked (the physical-copy image gate compares them exactly)
        if (f.image) await db.database.update({ where: { id: resourceId }, data: { image: f.image } });
        result = { name: f.name, databaseId: resourceId, credentialsCarried: !f["no-credentials"], imageCarried: true };
        items.push({ itemRef: ownerRef, kind: "database", proposed: { dataMode: "volume" } });
        destVolume = `tugra_dbv_${resourceId}`;
      } else {
        const a = must(await api("POST", "/apps", { name: f.name, serverId, image: "nginx:alpine" }, token), [201], "create the app");
        resourceId = a.id;
        await db.application.update({ where: { id: resourceId }, data: { volumes: [{ name: f.volume, path: f.path }] } });
        result = { volumes: { mounts: [{ path: f.path, name: f.volume }], declared: 1 } };
        destVolume = `tugra_appv_${resourceId}_${f.volume}`;
      }
      const migToken = `tugra_mig_${randomBytes(32).toString("base64url")}`;
      const op = await db.bulkOperation.create({
        data: {
          actorId: userId,
          command: "",
          kind: "import",
          planId: "lab",
          meta: { sourceKind: "coolify", serverId, hubBase: process.env.HUB_URL || hub, plan: { items } },
          migrationTokenHash: createHash("sha256").update(migToken).digest("hex"),
          migrationTokenExpiresAt: new Date(Date.now() + 6 * 3600_000),
        },
      });
      await db.bulkTask.create({
        data: { opId: op.id, serverId, kind: f.kind === "db" ? "database" : "app", itemRef: ownerRef, status: "DONE", resourceType: f.kind === "db" ? "database" : "application", resourceId, result },
      });
      kv("OP_ID", op.id);
      kv("MIG_TOKEN", migToken);
      kv(f.kind === "db" ? "DB_ID" : "APP_ID", resourceId);
      kv("ITEMREF", `volume:_:${f.source}:${f.kind === "db" ? "data" : f.volume}`);
      kv("DEST_VOLUME", destVolume);
      kv("SRC_CONTAINER", f.source);
      break;
    }
    case "transfer": {
      const opId = argv[0];
      const db = await prisma();
      const rows = await db.migrationVolumeTransfer.findMany({ where: { opId }, orderBy: { createdAt: "asc" } });
      if (rows.length === 0) console.log("NONE 0 - 0");
      for (const t of rows) console.log(`${t.state} ${t.partsDone} ${(t.error || "-").replace(/\s+/g, "_")} ${t.attempt}`);
      break;
    }
    case "db-status": {
      const db = await prisma();
      const d = await db.database.findUnique({ where: { id: argv[0] }, select: { status: true, image: true, version: true } });
      console.log(d ? `${d.status} ${d.image} ${d.version}` : "MISSING");
      break;
    }
    case "db-set": {
      const db = await prisma();
      await db.database.update({ where: { id: argv[0] }, data: { status: argv[1] } });
      console.log(`${argv[0]} ${argv[1]}`);
      break;
    }
    case "app": {
      const f = flags({ name: `lab-app-${Date.now()}`, volume: "data", path: "/usr/share/nginx/html", "server-id": "" });
      const serverId = f["server-id"] || process.env.SERVER_ID;
      const { token } = await login();
      const db = await prisma();
      const a = must(await api("POST", "/apps", { name: f.name, serverId, image: "nginx:alpine" }, token), [201], "create the app");
      await db.application.update({ where: { id: a.id }, data: { volumes: [{ name: f.volume, path: f.path }] } });
      kv("APP_ID", a.id);
      kv("APP_VOLUME", `tugra_appv_${a.id}_${f.volume}`);
      break;
    }
    default:
      throw new Error(`usage: seed.mjs base|server|token|server-status|op|transfer|db-status|db-set|app (got ${cmd ?? "nothing"})`);
  }
}

main()
  .then(async () => { if (prismaClient) await prismaClient.$disconnect(); })
  .catch(async (e) => {
    console.error(`seed: ${e.message}`);
    if (prismaClient) await prismaClient.$disconnect().catch(() => {});
    process.exit(1);
  });
