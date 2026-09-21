/**
 * Demo seed — fills a LOCAL dev database with a known login + rich, multi-team
 * data so the UI can be explored comfortably (team switcher, monitor→channel,
 * empty states, etc.). DEV ONLY: it WIPES existing data first.
 *
 * Run:  node apps/hub-api/prisma/seed.cjs
 * Login: demo@tugra.local / demo1234
 *
 * No ts-node/dotenv needed — plain JS, reads apps/hub-api/.env itself, and
 * mirrors the app's crypto (libsodium secretbox) + argon2id password hashing
 * so encrypted fields decrypt correctly and login works.
 */
const fs = require("fs");
const path = require("path");
const argon2 = require("argon2");
const _sodium = require("libsodium-wrappers");
const { PrismaClient } = require("@prisma/client");

// --- load apps/hub-api/.env into process.env (DATABASE_URL, SECRETS_ENCRYPTION_KEY) ---
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const prisma = new PrismaClient();

async function main() {
  await _sodium.ready;
  const sodium = _sodium;
  const passphrase = process.env.SECRETS_ENCRYPTION_KEY;
  if (!passphrase) throw new Error("SECRETS_ENCRYPTION_KEY missing — is apps/hub-api/.env set?");
  const key = sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, passphrase, null);
  const enc = (plaintext) => {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const cipher = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, key);
    const combined = new Uint8Array(nonce.length + cipher.length);
    combined.set(nonce);
    combined.set(cipher, nonce.length);
    return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
  };
  const encJson = (obj) => enc(JSON.stringify(obj));

  // --- wipe (dev reset). Teams cascade most children; standalone tables go first ---
  console.log("• wiping existing data…");
  await prisma.auditLog.deleteMany();
  await prisma.bulkOperation.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();

  // --- users ---
  console.log("• creating users…");
  const pwHash = await argon2.hash("demo1234", { type: argon2.argon2id });
  const demo = await prisma.user.create({
    data: { email: "demo@tugra.local", password: pwHash, name: "Demo User" },
  });
  const mate = await prisma.user.create({
    data: { email: "teammate@tugra.local", password: pwHash, name: "Ada Teammate" },
  });

  // Mark the instance as already bootstrapped. The real first-user registration claims
  // InstanceSettings.initializedAt; the seed creates users directly, so set it here too —
  // otherwise the UI treats the instance as a fresh install and bounces /login → /welcome.
  await prisma.instanceSettings.upsert({
    where: { id: "singleton" },
    update: { initializedAt: new Date() },
    create: { id: "singleton", initializedAt: new Date() },
  });

  let tokenN = 0;
  const newToken = () => `seed-${Date.now()}-${tokenN++}-${Math.floor(performance.now())}`;

  // helper: create a team owned by demo + return it
  async function team(name, extraMembers = []) {
    const t = await prisma.team.create({ data: { name } });
    await prisma.membership.create({ data: { userId: demo.id, teamId: t.id, role: "OWNER" } });
    for (const m of extraMembers) {
      await prisma.membership.create({ data: { userId: m.userId, teamId: t.id, role: m.role } });
    }
    return t;
  }

  console.log("• creating teams…");
  const prod = await team("Acme Production", [{ userId: mate.id, role: "ADMIN" }]);
  const stg = await team("Acme Staging");
  const side = await team("Side Projects");

  // ---------- Team A: Acme Production (rich) ----------
  console.log("• Acme Production…");
  const pStore = await prisma.project.create({
    data: {
      teamId: prod.id,
      name: "Storefront",
      environments: { create: [{ name: "production" }, { name: "staging" }] },
    },
    include: { environments: true },
  });
  const envProd = pStore.environments.find((e) => e.name === "production");
  await prisma.project.create({
    data: { teamId: prod.id, name: "Internal Tools", environments: { create: [{ name: "production" }] } },
  });

  const srv1 = await prisma.server.create({
    data: {
      teamId: prod.id,
      name: "hetzner-fsn1",
      enrollToken: newToken(),
      status: "ONLINE",
      hostname: "fsn1.acme.dev",
      os: "Ubuntu",
      osVersion: "24.04",
      arch: "amd64",
      cpuCores: 8,
      memTotalBytes: BigInt(33554432000),
      agentVersion: "0.1.0",
      lastSeenAt: new Date(),
      tags: ["prod", "eu"],
    },
  });
  const srv2 = await prisma.server.create({
    data: { teamId: prod.id, name: "hetzner-nbg1", enrollToken: newToken(), status: "OFFLINE", tags: ["prod"] },
  });
  // a few metric rows so the server isn't graph-empty
  for (let i = 6; i >= 0; i--) {
    await prisma.metric.create({
      data: {
        serverId: srv1.id,
        ts: new Date(Date.now() - i * 60000),
        cpu: 12 + Math.round(Math.random() * 30),
        memUsed: BigInt(12000000000 + i * 200000000),
        memTotal: BigInt(33554432000),
        diskUsed: BigInt(48000000000),
        diskTotal: BigInt(160000000000),
        netRx: BigInt(1200000 + i * 5000),
        netTx: BigInt(800000 + i * 4000),
      },
    });
  }

  const app1 = await prisma.application.create({
    data: {
      teamId: prod.id,
      serverId: srv1.id,
      environmentId: envProd?.id,
      name: "storefront-web",
      source: "IMAGE",
      image: "ghcr.io/acme/storefront:latest",
      status: "RUNNING",
      domain: "shop.acme.dev",
      containerPort: 3000,
      env: {},
      tags: ["web"],
    },
  });
  await prisma.deployment.create({
    data: { appId: app1.id, status: "SUCCESS", exitCode: 0, imageTag: "latest", logs: "Pulled image\nStarted container\nHealthy ✓" },
  });

  const db1 = await prisma.database.create({
    data: {
      teamId: prod.id,
      serverId: srv1.id,
      environmentId: envProd?.id,
      name: "storefront-pg",
      engine: "POSTGRES",
      version: "16",
      image: "postgres:16-alpine",
      port: 5432,
      hostPort: 5432,
      credentials: encJson({ user: "app", password: "s3cret", db: "storefront" }),
      status: "RUNNING",
      backupEnabled: true,
      backupIntervalHours: 24,
      tags: ["primary"],
    },
  });

  const dest1 = await prisma.backupDestination.create({
    data: {
      teamId: prod.id,
      name: "Backblaze B2",
      type: "S3",
      s3Bucket: "acme-backups",
      s3Region: "us-west-001",
      s3Endpoint: "https://s3.us-west-001.backblazeb2.com",
      s3AccessKey: "DEMOKEY",
      s3SecretKey: enc("demo-secret"),
    },
  });
  await prisma.backup.create({
    data: { databaseId: db1.id, status: "SUCCESS", filename: "storefront-pg-2026-06-28.sql.gz", path: "/backups/storefront-pg-2026-06-28.sql.gz", destinationId: dest1.id, sizeBytes: BigInt(48211000), createdBy: demo.id, completedAt: new Date() },
  });

  const chSlack = await prisma.notificationChannel.create({
    data: { teamId: prod.id, name: "Ops Slack", type: "slack", configEnc: encJson({ webhookUrl: "https://hooks.slack.com/services/XXX" }), eventTypes: ["deploy_failed", "server_offline", "backup_failed"] },
  });
  const chMail = await prisma.notificationChannel.create({
    data: { teamId: prod.id, name: "On-call Email", type: "smtp", configEnc: encJson({ host: "smtp.acme.dev", port: 587, user: "alerts@acme.dev", pass: "x", from: "alerts@acme.dev", to: "oncall@acme.dev" }), eventTypes: ["deploy_failed", "ssl_expiring"] },
  });

  const mon1 = await prisma.monitor.create({
    data: { teamId: prod.id, name: "Storefront uptime", type: "HTTP", target: "https://shop.acme.dev", intervalSec: 30, status: "UP", channels: { create: [{ channelId: chSlack.id }, { channelId: chMail.id }] } },
  });
  await prisma.monitor.create({
    data: { teamId: prod.id, name: "DB disk", type: "METRIC", target: "Disk usage", serverId: srv1.id, metric: "DISK", thresholdPct: 85, status: "UP", channels: { create: [{ channelId: chSlack.id }] } },
  });
  // heartbeats for the HTTP monitor (uptime graph)
  for (let i = 30; i >= 0; i--) {
    await prisma.heartbeat.create({
      data: { monitorId: mon1.id, status: i === 7 ? "DOWN" : "UP", ms: 90 + Math.round(Math.random() * 80), ts: new Date(Date.now() - i * 60000), important: i === 7 },
    });
  }

  await prisma.gitSource.create({
    data: { teamId: prod.id, name: "github-acme", provider: "github", appId: "987654", appSlug: "acme-deployer", privateKeyEnc: enc("-----BEGIN KEY-----demo-----END KEY-----"), htmlUrl: "https://github.com/apps/acme-deployer" },
  });
  await prisma.sharedVariable.create({ data: { teamId: prod.id, key: "SENTRY_DSN", valueEnc: enc("https://demo@sentry.io/123") } });
  await prisma.sharedVariable.create({ data: { teamId: prod.id, key: "NODE_ENV", valueEnc: enc("production") } });
  await prisma.apiToken.create({ data: { userId: demo.id, name: "CI deploy token", tokenHash: enc(newToken()), prefix: "tgr_ci01" } });

  // ---------- Team B: Acme Staging (light) ----------
  console.log("• Acme Staging…");
  await prisma.project.create({ data: { teamId: stg.id, name: "Sandbox", environments: { create: [{ name: "staging" }] } } });
  const srvStg = await prisma.server.create({ data: { teamId: stg.id, name: "staging-box", enrollToken: newToken(), status: "ONLINE", tags: ["staging"] } });
  const chStg = await prisma.notificationChannel.create({
    data: { teamId: stg.id, name: "Staging Discord", type: "discord", configEnc: encJson({ webhookUrl: "https://discord.com/api/webhooks/XXX" }), eventTypes: ["deploy_failed"] },
  });
  await prisma.monitor.create({ data: { teamId: stg.id, name: "Staging API", type: "HTTP", target: "https://staging.acme.dev/health", status: "PENDING", channels: { create: [{ channelId: chStg.id }] } } });
  void srvStg;

  // ---------- Team C: Side Projects (NO channels → shows monitor→channel empty state) ----------
  console.log("• Side Projects…");
  await prisma.project.create({ data: { teamId: side.id, name: "Blog", environments: { create: [{ name: "production" }] } } });
  await prisma.monitor.create({ data: { teamId: side.id, name: "Blog uptime", type: "HTTP", target: "https://blog.example.com", status: "UP" } });

  // ---------- Audit log (actor = user id → resolves to email in UI) ----------
  console.log("• audit log…");
  const actions = [
    [demo.id, "auth.login", null],
    [demo.id, "project.create", "Storefront"],
    [demo.id, "app.deploy", "storefront-web"],
    [demo.id, "database.create", "storefront-pg"],
    [demo.id, "channel.create", "Ops Slack"],
    [mate.id, "monitor.create", "Storefront uptime"],
    [mate.id, "backup.create", "storefront-pg"],
  ];
  for (let i = 0; i < actions.length; i++) {
    const [actor, action, target] = actions[i];
    await prisma.auditLog.create({ data: { actor, action, target, createdAt: new Date(Date.now() - i * 3600000) } });
  }

  console.log("\n✅ Seed done.");
  console.log("   Login:  demo@tugra.local  /  demo1234");
  console.log("   Teams:  Acme Production · Acme Staging · Side Projects  (switcher visible)");
  console.log("   Side Projects has NO channels → monitor→channel empty state.\n");
}

main()
  .catch((e) => { console.error("Seed failed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
