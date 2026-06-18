import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Shared variables (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `sv-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
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
      .send({ email, password, name: "SV" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "sv-node", teamId })
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
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode: 0, output: "Up" }));
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

  it("merges team shared vars into a deploy, with app env winning on conflicts", async () => {
    // team shared: FOO=team, SHARED=1
    await request(app.getHttpServer()).post("/shared-variables").set("Authorization", `Bearer ${token}`).send({ teamId, key: "FOO", value: "team" }).expect(201);
    await request(app.getHttpServer()).post("/shared-variables").set("Authorization", `Bearer ${token}`).send({ teamId, key: "SHARED", value: "1" }).expect(201);

    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "svapp", serverId, image: "nginx:alpine", hostPort: 8123 })
      .expect(201);
    const appId = appRes.body.id;
    await request(app.getHttpServer()).put(`/apps/${appId}/env`).set("Authorization", `Bearer ${token}`).send({ env: { FOO: "app", BAR: "x" } }).expect(200);

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${appId}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(150);

    const m = commands.join("\n").match(/printf %s '([A-Za-z0-9+/=]+)'/);
    expect(m).toBeTruthy();
    const envFile = Buffer.from(m![1], "base64").toString();
    expect(envFile).toContain("FOO=app"); // app overrides shared
    expect(envFile).not.toContain("FOO=team");
    expect(envFile).toContain("BAR=x");
    expect(envFile).toContain("SHARED=1"); // shared-only var present
  });

  it("lists + deletes shared variables", async () => {
    const list = await request(app.getHttpServer())
      .get(`/shared-variables?teamId=${teamId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const foo = list.body.find((v: { key: string }) => v.key === "FOO");
    expect(foo.value).toBe("team");
    await request(app.getHttpServer())
      .delete(`/shared-variables/${foo.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  });
});
