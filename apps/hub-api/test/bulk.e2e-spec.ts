import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Bulk ops (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `bulk-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let agent: WebSocket;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "Bulk" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;
  });

  afterAll(async () => {
    agent?.close();
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("runs a command across selected servers and records per-server results", async () => {
    // create a server + enroll a simulated agent that echoes commands
    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "node-1", teamId })
      .expect(201);
    const serverId = created.body.server.id;
    const enrollToken = created.body.enrollToken;
    const { publicKey } = generateKeyPairSync("ed25519");
    const spkiB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

    agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    await new Promise<void>((resolve, reject) => {
      agent.on("error", reject);
      agent.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge") {
          agent.send(JSON.stringify({ type: "enroll", protocol: 1, token: enrollToken, publicKey: spkiB64, agentVersion: "e2e", hostname: "h", fingerprint: "f" }));
        } else if (msg.type === "enrolled") {
          resolve();
        } else if (msg.type === "command") {
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode: 0, output: `ran: ${msg.command}` }));
        }
      });
    });

    const op = await request(app.getHttpServer())
      .post("/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ serverIds: [serverId], command: "echo hi" })
      .expect(201);
    const opId = op.body.opId;

    let task: { status: string; exitCode: number | null; output: string | null } | undefined;
    for (let i = 0; i < 30; i++) {
      const res = await request(app.getHttpServer())
        .get(`/bulk/${opId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      task = res.body.tasks[0];
      if (task && (task.status === "DONE" || task.status === "FAILED")) break;
      await sleep(200);
    }
    expect(task?.status).toBe("DONE");
    expect(task?.exitCode).toBe(0);
    expect(task?.output).toContain("echo hi");
  });

  it("skips servers the user cannot write to", async () => {
    // a server in another team where the user has no role → SKIPPED
    const otherTeam = await prisma.team.create({ data: { name: "other" } });
    const foreign = await prisma.server.create({
      data: { name: "foreign", teamId: otherTeam.id, enrollToken: `tok-${Date.now()}` },
    });

    const op = await request(app.getHttpServer())
      .post("/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ serverIds: [foreign.id], command: "echo hi" })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/bulk/${op.body.opId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.tasks[0].status).toBe("SKIPPED");

    await prisma.team.deleteMany({ where: { id: otherTeam.id } }).catch(() => undefined);
  });

  it("bulk-applies cleanup config to writable servers and skips foreign ones", async () => {
    const mine = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "fleet-1", teamId })
      .expect(201);
    const mineId = mine.body.server.id;

    const otherTeam = await prisma.team.create({ data: { name: "fleet-other" } });
    const foreign = await prisma.server.create({
      data: { name: "fleet-foreign", teamId: otherTeam.id, enrollToken: `ftok-${Date.now()}` },
    });

    // enabled:false → exercises route + zod + role-gating + persistence without
    // scheduling a real long-lived cleanup timer in the test process.
    const res = await request(app.getHttpServer())
      .post("/fleet/cleanup-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ serverIds: [mineId, foreign.id], enabled: false, intervalHours: 24 })
      .expect(200);
    expect(res.body.applied).toEqual([mineId]);
    expect(res.body.skipped).toEqual([foreign.id]);

    const srv = await prisma.server.findUnique({ where: { id: mineId } });
    expect(srv?.cleanupIntervalHours).toBe(24);
    expect(srv?.cleanupEnabled).toBe(false);

    await prisma.team.deleteMany({ where: { id: otherTeam.id } }).catch(() => undefined);
  });

  it("bulk-applies backup schedule to writable databases and skips foreign ones", async () => {
    const dbData = { serverId: "srv-x", name: "d", engine: "POSTGRES" as const, version: "16", image: "postgres:16-alpine", port: 5432, credentials: "x" };
    // Databases require an environment (FK). Reuse my team's default env; give the foreign team its own.
    const mineEnv = (await prisma.environment.findFirst({ where: { project: { teamId } } }))!;
    const mineDb = await prisma.database.create({ data: { ...dbData, teamId, environmentId: mineEnv.id, name: "bulk-db" } });
    const otherTeam = await prisma.team.create({ data: { name: "db-other" } });
    const otherProject = await prisma.project.create({ data: { name: "p", teamId: otherTeam.id } });
    const otherEnv = await prisma.environment.create({ data: { name: "e", projectId: otherProject.id } });
    const foreignDb = await prisma.database.create({ data: { ...dbData, teamId: otherTeam.id, environmentId: otherEnv.id, name: "db-foreign" } });

    // enabled:false → no long-lived scheduler timer; still exercises route + role-gating + persistence.
    const res = await request(app.getHttpServer())
      .post("/fleet/backup-config")
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseIds: [mineDb.id, foreignDb.id], enabled: false, intervalHours: 12, retention: 5 })
      .expect(200);
    expect(res.body.applied).toEqual([mineDb.id]);
    expect(res.body.skipped).toEqual([foreignDb.id]);

    const got = await prisma.database.findUnique({ where: { id: mineDb.id } });
    expect(got?.backupIntervalHours).toBe(12);
    expect(got?.backupRetention).toBe(5);
    expect(got?.backupEnabled).toBe(false);

    await prisma.team.deleteMany({ where: { id: otherTeam.id } }).catch(() => undefined);
  });

  it("bulk-sets notification channels on writable monitors (same-team only)", async () => {
    const mon = await prisma.monitor.create({ data: { teamId, name: "m-bulk", type: "HTTP", target: "https://x.test" } });
    const ch = await prisma.notificationChannel.create({ data: { teamId, name: "ch-bulk", type: "webhook", configEnc: "x" } });
    const otherTeam = await prisma.team.create({ data: { name: "mon-other" } });
    const foreignMon = await prisma.monitor.create({ data: { teamId: otherTeam.id, name: "m-foreign", type: "HTTP", target: "https://y.test" } });

    const res = await request(app.getHttpServer())
      .post("/monitors/channels/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ monitorIds: [mon.id, foreignMon.id], channelIds: [ch.id] })
      .expect(200);
    expect(res.body.applied).toEqual([mon.id]);
    expect(res.body.skipped).toEqual([foreignMon.id]);

    const links = await prisma.monitorChannel.findMany({ where: { monitorId: mon.id } });
    expect(links.map((l) => l.channelId)).toEqual([ch.id]);

    await prisma.team.deleteMany({ where: { id: otherTeam.id } }).catch(() => undefined);
  });
});
