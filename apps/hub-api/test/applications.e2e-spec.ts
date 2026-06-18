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
          // capture + simulate a successful docker deploy, streaming a live log
          // chunk before the final result (exercises command_log → SSE).
          commands.push(msg.command);
          agent.send(JSON.stringify({ type: "command_log", reqId: msg.reqId, chunk: "live-build-line\n" }));
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

  it("manages env vars (encrypted) and injects them via --env-file on deploy", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "envapp", serverId, image: "nginx:alpine", hostPort: 8090 })
      .expect(201);
    const appId = appRes.body.id;
    expect(appRes.body.envCount).toBe(0);

    await request(app.getHttpServer())
      .put(`/apps/${appId}/env`)
      .set("Authorization", `Bearer ${token}`)
      .send({ env: { FOO: "bar", SECRET: "s3cr3t" } })
      .expect(200);

    const got = await request(app.getHttpServer())
      .get(`/apps/${appId}/env`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(got.body).toEqual({ FOO: "bar", SECRET: "s3cr3t" });

    commands.length = 0;
    await request(app.getHttpServer())
      .post(`/apps/${appId}/deploy`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(200);

    const sent = commands.join("\n");
    expect(sent).toContain("--env-file /etc/tugra/env/");
    expect(sent).not.toContain("-e 'FOO"); // secrets not on the command line
    const m = sent.match(/printf %s '([A-Za-z0-9+/=]+)'/);
    expect(m).toBeTruthy();
    expect(Buffer.from(m![1], "base64").toString()).toContain("SECRET=s3cr3t");
  });

  it("rolls back to a previous deployment's image without rebuilding", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "rbapp", serverId, image: "nginx:alpine", hostPort: 8095 })
      .expect(201);
    const appId = appRes.body.id;

    const deployOnce = async () => {
      await request(app.getHttpServer()).post(`/apps/${appId}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
      await sleep(120);
    };
    await deployOnce(); // dep1
    await deployOnce(); // dep2 (current)

    const list = await request(app.getHttpServer())
      .get(`/apps/${appId}/deployments`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    // newest first; the oldest is the rollback target
    const target = list.body[list.body.length - 1];
    expect(target.imageTag).toBeTruthy();

    commands.length = 0;
    const rb = await request(app.getHttpServer())
      .post(`/apps/${appId}/rollback/${target.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(rb.body.status).toBe("SUCCESS");
    await sleep(120);

    const sent = commands.join("\n");
    expect(sent).toContain(`tugra_${appId}:${target.id}`);
    expect(sent).not.toContain("docker pull");
  });

  it("rejects rollback to an unknown deployment", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "rbapp2", serverId, image: "nginx:alpine" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/apps/${appRes.body.id}/rollback/nonexistent`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });

  it("deploys a Docker Compose app as a project and stops it via compose", async () => {
    const compose = "services:\n  web:\n    image: nginx:alpine\n    ports:\n      - 8099:80";
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "stack", serverId, source: "COMPOSE", composeFile: compose })
      .expect(201);
    const appId = appRes.body.id;
    expect(appRes.body.source).toBe("COMPOSE");
    expect(appRes.body.composeFile).toContain("services:");

    commands.length = 0;
    const dep = await request(app.getHttpServer())
      .post(`/apps/${appId}/deploy`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(dep.body.status).toBe("SUCCESS");
    expect(dep.body.imageTag).toBeNull(); // compose → no single rollback image
    await sleep(150);

    const sent = commands.join("\n");
    expect(sent).toContain(`docker compose -p tugra_${appId}`);
    expect(sent).toContain("up -d --remove-orphans");
    expect(sent).not.toContain("docker run -d");

    commands.length = 0;
    await request(app.getHttpServer())
      .post(`/apps/${appId}/stop`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(80);
    expect(commands.join("\n")).toContain(`docker compose -p tugra_${appId}`);
  });

  it("applies resource limits + health-check at deploy", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "limapp", serverId, image: "nginx:alpine", hostPort: 8131 })
      .expect(201);
    const appId = appRes.body.id;

    await request(app.getHttpServer())
      .put(`/apps/${appId}/limits`)
      .set("Authorization", `Bearer ${token}`)
      .send({ healthCmd: "curl -fsS http://localhost:80/ || exit 1", memoryMb: 256, cpus: 0.5 })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/apps/${appId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.memoryMb).toBe(256);
    expect(detail.body.cpus).toBe(0.5);

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${appId}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(150);
    const sent = commands.join("\n");
    expect(sent).toContain("--memory 256m");
    expect(sent).toContain("--cpus 0.5");
    expect(sent).toContain("--health-cmd");
  });

  it("streams live build logs over SSE (agent command_log → hub → client)", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "logapp", serverId, image: "nginx:alpine", hostPort: 8132 })
      .expect(201);
    const appId = appRes.body.id;

    // Deploy completes (agent replies); the stream entry is retained briefly so
    // a subscriber replays the buffered chunks + the terminal done event.
    await request(app.getHttpServer())
      .post(`/apps/${appId}/deploy`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const stream = await request(app.getHttpServer())
      .get(`/apps/${appId}/deployments/stream`)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .expect(200);

    expect(stream.text).toContain("live-build-line");
    expect(stream.text).toContain('"type":"done"');
    expect(stream.text).toContain('"status":"SUCCESS"');
  });

  it("rejects rollback for a compose app", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "stack2", serverId, source: "COMPOSE", composeFile: "services: {}" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/apps/${appRes.body.id}/rollback/whatever`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });
});
