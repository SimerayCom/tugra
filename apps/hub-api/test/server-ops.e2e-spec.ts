import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Server ops / docker cleanup (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `ops-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
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
      .send({ email, password, name: "OPS" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "ops-node", teamId })
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
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode: 0, output: "Total reclaimed space: 1.2GB" }));
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

  it("runs an on-demand docker cleanup", async () => {
    commands.length = 0;
    const res = await request(app.getHttpServer())
      .post(`/servers/${serverId}/cleanup`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.output).toContain("reclaimed");
    await sleep(60);
    expect(commands.join("\n")).toContain("docker system prune -af");
    expect(commands.join("\n")).not.toContain("--volumes"); // default off
  });

  it("saves a cleanup schedule config (with volumes)", async () => {
    await request(app.getHttpServer())
      .put(`/servers/${serverId}/cleanup-config`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true, intervalHours: 12, volumes: true })
      .expect(200);
    const detail = await request(app.getHttpServer())
      .get(`/servers/${serverId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.cleanupEnabled).toBe(true);
    expect(detail.body.cleanupIntervalHours).toBe(12);
    expect(detail.body.cleanupVolumes).toBe(true);

    // now a cleanup includes --volumes
    commands.length = 0;
    await request(app.getHttpServer())
      .post(`/servers/${serverId}/cleanup`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(60);
    expect(commands.join("\n")).toContain("docker system prune -af --volumes");
  });
});
