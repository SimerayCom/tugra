import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Database backups (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `bk-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let agent: WebSocket;
  let serverId = "";
  let dbId = "";
  const commands: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "BK" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "bk-node", teamId })
      .expect(201);
    serverId = created.body.server.id;
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
          commands.push(msg.command);
          // backup script ends with `stat -c %s` → echo a byte size
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode: 0, output: "20480" }));
        }
      });
    });

    const dbRes = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "appdb", serverId, engine: "POSTGRES" })
      .expect(201);
    dbId = dbRes.body.id;
  });

  afterAll(async () => {
    agent?.close();
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("runs an on-demand backup (dump written on the server) and records it", async () => {
    commands.length = 0;
    const res = await request(app.getHttpServer())
      .post(`/databases/${dbId}/backups`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    expect(res.body.status).toBe("SUCCESS");
    expect(res.body.sizeBytes).toBe("20480");
    expect(res.body.filename).toMatch(/\.sql\.gz$/);
    await sleep(50);

    const sent = commands.join("\n");
    expect(sent).toContain("pg_dump");
    expect(sent).toContain("stat -c %s");

    const list = await request(app.getHttpServer())
      .get(`/databases/${dbId}/backups`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
  });

  it("restores from a backup by sending a psql restore command to the agent", async () => {
    const list = await request(app.getHttpServer())
      .get(`/databases/${dbId}/backups`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const backupId = list.body[0].id;

    commands.length = 0;
    await request(app.getHttpServer())
      .post(`/databases/${dbId}/backups/${backupId}/restore`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(50);
    expect(commands.join("\n")).toContain("psql");
  });

  it("saves a backup schedule config", async () => {
    await request(app.getHttpServer())
      .put(`/databases/${dbId}/backup-config`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true, intervalHours: 12, retention: 5 })
      .expect(200);
    const db = await prisma.database.findUnique({ where: { id: dbId } });
    expect(db?.backupEnabled).toBe(true);
    expect(db?.backupIntervalHours).toBe(12);
  });

  it("rejects backups for a non-existent database", async () => {
    await request(app.getHttpServer())
      .post(`/databases/nonexistent/backups`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });
});
