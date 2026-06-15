import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Databases (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `db-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let agent: WebSocket;
  let serverId = "";
  const commands: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "DB" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "db-node", teamId })
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
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode: 0, output: "Up 2 seconds" }));
        }
      });
    });
  });

  afterAll(async () => {
    agent?.close();
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("creates a Postgres database, provisions it via the agent, and exposes connection info to the owner", async () => {
    const res = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "appdb", serverId, engine: "POSTGRES" })
      .expect(201);
    const dbId = res.body.id;
    expect(res.body.engine).toBe("POSTGRES");
    expect(res.body.status).toBe("NEW");
    expect(res.body.connectionUri).toContain("postgresql://");
    expect(res.body.password).toBeTruthy();

    commands.length = 0;
    const prov = await request(app.getHttpServer())
      .post(`/databases/${dbId}/provision`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(prov.body.status).toBe("RUNNING");
    await sleep(100);

    const sent = commands.join("\n");
    expect(sent).toContain("docker run");
    expect(sent).toContain("--network tugra-net");
    expect(sent).toContain("-v tugra_dbv_");
    expect(sent).toContain("postgres:16");

    const detail = await request(app.getHttpServer())
      .get(`/databases/${dbId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.status).toBe("RUNNING");
  });

  it("rejects creating a database on a server the user has no access to", async () => {
    await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x", serverId: "nonexistent-server", engine: "REDIS" })
      .expect(404);
  });
});
