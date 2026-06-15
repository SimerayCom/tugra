import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Applications / deploy (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `app-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
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
      .send({ email, password, name: "App" })
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

  it("creates an app, deploys it via the agent, and records a successful deployment", async () => {
    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "deploy-node", teamId })
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
          // capture + simulate a successful docker deploy
          commands.push(msg.command);
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode: 0, output: "Up 2 seconds" }));
        }
      });
    });

    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "web", serverId, image: "nginx:alpine", hostPort: 8080 })
      .expect(201);
    const appId = appRes.body.id;
    expect(appRes.body.status).toBe("NEW");

    await request(app.getHttpServer())
      .post(`/apps/${appId}/deploy`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(200);

    const deployments = await request(app.getHttpServer())
      .get(`/apps/${appId}/deployments`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(deployments.body[0].status).toBe("SUCCESS");
    expect(deployments.body[0].logs).toContain("Up");

    const detail = await request(app.getHttpServer())
      .get(`/apps/${appId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.status).toBe("RUNNING");
  });

  it("deploys an app with a domain → proxy setup + Traefik labels", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "site", serverId, image: "nginx:alpine", domain: "site.example.com" })
      .expect(201);
    expect(appRes.body.domain).toBe("site.example.com");
    expect(appRes.body.url).toBe("https://site.example.com");

    commands.length = 0;
    await request(app.getHttpServer())
      .post(`/apps/${appRes.body.id}/deploy`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(300);

    // proxy setup + run-with-labels were sent to the agent
    expect(commands.some((c) => c.includes("traefik:v3.1"))).toBe(true);
    expect(commands.some((c) => c.includes("Host(`site.example.com`)"))).toBe(true);
    expect(commands.some((c) => c.includes("--network tugra-proxy"))).toBe(true);
  });

  it("deploys a GIT app → clone + nixpacks build", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "gitapp", serverId, source: "GIT", gitUrl: "https://github.com/u/r.git", gitBranch: "main" })
      .expect(201);
    expect(appRes.body.source).toBe("GIT");

    commands.length = 0;
    await request(app.getHttpServer())
      .post(`/apps/${appRes.body.id}/deploy`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(300);

    const all = commands.join("\n");
    expect(all).toContain("git clone");
    expect(all).toContain("nixpacks build");
    expect(all).not.toContain("docker pull");
  });
});
