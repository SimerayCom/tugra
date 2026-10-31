import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Poll the shared mock-agent command buffer until `needle` appears. A deploy is fire-and-forget (the HTTP
// call returns before the async claim→execute→sendCommand chain runs), so a fixed sleep raced it on a slow
// CI runner. Use this for a positive "the command was sent" assertion instead of a fixed sleep.
const waitForCommand = async (commands: string[], needle: string, timeoutMs = 8000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (commands.join("\n").includes(needle)) return;
    await sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a command containing ${JSON.stringify(needle)}`);
};

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
  const logStarts: { streamId: string; target: string; tail: number; follow: boolean; sig?: string }[] = [];
  let nextExit = 0; // mock-agent exit code for the next command (reset per use)

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
          // capture + simulate a docker deploy, streaming a live log chunk before the final result
          // (exercises command_log → SSE). `nextExit` models the DEPLOY health gate, so only the
          // health-gated deploy command (it carries the TUGRA_ROLLOUT marker) honours it; infra
          // commands (proxy setup — which now fails loud — cleanup, image prep) always succeed, so a
          // failed-gate test exercises the rollback path instead of tripping on proxy setup.
          commands.push(msg.command);
          agent.send(JSON.stringify({ type: "command_log", reqId: msg.reqId, chunk: "live-build-line\n" }));
          const exitCode = nextExit !== 0 && !msg.command.includes("TUGRA_ROLLOUT") ? 0 : nextExit;
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode, output: "Up 2 seconds" }));
        } else if (msg.type === "log_start") {
          // Simulate `docker logs`: stream one line then exit (exercises the full
          // log_start → log_chunk → log_exit → SSE round-trip).
          logStarts.push(msg);
          agent.send(JSON.stringify({ type: "log_chunk", streamId: msg.streamId, chunk: "live-log-line-1" }));
          agent.send(JSON.stringify({ type: "log_exit", streamId: msg.streamId, exitCode: 0 }));
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

    // RESFLOW: an app created without an environment lands in the team's default
    // environment, never orphaned with a null environmentId.
    const persisted = await prisma.application.findUnique({
      where: { id: appId },
      select: { environmentId: true },
    });
    const defEnv = await prisma.environment.findFirst({
      where: { isDefault: true, project: { teamId, isDefault: true } },
      select: { id: true },
    });
    expect(persisted?.environmentId).toBeTruthy();
    expect(persisted?.environmentId).toBe(defEnv?.id);

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

    // AI analysis is opt-in: with no ANTHROPIC_API_KEY in the test env it 503s
    // (proves the wiring without any external call).
    await request(app.getHttpServer())
      .post(`/apps/${appId}/deployments/${deployments.body[0].id}/analyze`)
      .set("Authorization", `Bearer ${token}`)
      .expect(503);

    // Runtime container logs run docker logs on the agent.
    commands.length = 0;
    const logs = await request(app.getHttpServer())
      .get(`/apps/${appId}/logs?tail=50`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(typeof logs.body.output).toBe("string");
    expect(commands.join("\n")).toContain(`docker logs --tail 50 tugra_${appId}`);

    // Restart is a lifecycle action (no rebuild): docker restart + RUNNING.
    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${appId}/restart`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(60);
    expect(commands.join("\n")).toContain(`docker restart tugra_${appId}`);
    const after = await request(app.getHttpServer()).get(`/apps/${appId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(after.body.status).toBe("RUNNING");

    // Rename (display-only; no redeploy).
    await request(app.getHttpServer()).put(`/apps/${appId}/name`).set("Authorization", `Bearer ${token}`).send({ name: "renamed-web" }).expect(200);
    const renamed = await request(app.getHttpServer()).get(`/apps/${appId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(renamed.body.name).toBe("renamed-web");
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
    expect(commands.some((c) => c.includes("traefik:v3."))).toBe(true);
    expect(commands.some((c) => c.includes("Host(`site.example.com`)"))).toBe(true);
    expect(commands.some((c) => c.includes("--network tugra-proxy"))).toBe(true);
  });

  it("auto-creates an uptime monitor for a domained app, editable + removed on delete", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "monsite", serverId, image: "nginx:alpine", domain: "mon.example.com" })
      .expect(201);
    const appId = appRes.body.id;
    await sleep(150);

    const list = await request(app.getHttpServer()).get("/monitors").set("Authorization", `Bearer ${token}`).expect(200);
    const auto = list.body.find((m: { appId?: string }) => m.appId === appId);
    expect(auto).toBeTruthy();
    expect(auto.auto).toBe(true);
    expect(auto.type).toBe("HTTP");
    expect(auto.target).toBe("https://mon.example.com");

    // editable
    await request(app.getHttpServer())
      .put(`/monitors/${auto.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ intervalSec: 60 })
      .expect(200);
    const got = await request(app.getHttpServer()).get(`/monitors/${auto.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(got.body.intervalSec).toBe(60);

    // removed when the app is deleted
    await request(app.getHttpServer()).delete(`/apps/${appId}`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(150);
    const after = await request(app.getHttpServer()).get("/monitors").set("Authorization", `Bearer ${token}`).expect(200);
    expect(after.body.some((m: { id: string }) => m.id === auto.id)).toBe(false);
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

  it("deploys a GIT app with STATIC build → clone + docker build (nginx)", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "spaapp", serverId, source: "GIT", gitUrl: "https://github.com/u/spa.git", buildType: "STATIC", buildCommand: "npm run build", outputDir: "dist" })
      .expect(201);
    expect(appRes.body.buildType).toBe("STATIC");
    expect(appRes.body.buildCommand).toBe("npm run build");

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${appRes.body.id}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(300);
    const all = commands.join("\n");
    expect(all).toContain("git clone");
    expect(all).toContain("Dockerfile.tugra");
    expect(all).toContain("docker build -t");
    expect(all).not.toContain("nixpacks");
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
    // Poll for the deploy command instead of a fixed sleep: the deploy is fire-and-forget (claim → execute
    // → resolve env → sendCommand) and on a slow runner the command can arrive after a short sleep, which
    // flaked this assertion. waitForCommand resolves as soon as the env-file command is sent.
    await waitForCommand(commands, "--env-file /etc/tugra/env/");

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
      .send({ memoryMb: 256, cpus: 0.5 })
      .expect(200);

    // health-check config lives on its own endpoint (type CMD → container --health-cmd)
    await request(app.getHttpServer())
      .put(`/apps/${appId}/health-check`)
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "CMD", command: "curl -fsS http://localhost:80/ || exit 1" })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/apps/${appId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.memoryMb).toBe(256);
    expect(detail.body.cpus).toBe(0.5);
    expect(detail.body.healthCheckType).toBe("CMD");
    expect(detail.body.healthCmd).toBe("curl -fsS http://localhost:80/ || exit 1");

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${appId}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(150);
    const sent = commands.join("\n");
    expect(sent).toContain("--memory 256m");
    expect(sent).toContain("--cpus 0.5");
    expect(sent).toContain("--health-cmd");
  });

  it("rejects a CMD health check with no command (400)", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "hcapp", serverId, image: "nginx:alpine", hostPort: 8136 })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/apps/${appRes.body.id}/health-check`)
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "CMD", command: null })
      .expect(400);
  });

  it("creates a registry (password never returned) and pushes the built image on deploy", async () => {
    const regRes = await request(app.getHttpServer())
      .post("/registries")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "myreg", teamId, type: "generic", url: "reg.example.com", username: "bot", password: "s3cr3t", imagePrefix: "org" })
      .expect(201);
    expect(regRes.body).not.toHaveProperty("passwordEnc");
    expect(regRes.body).not.toHaveProperty("password");
    expect(regRes.body).toMatchObject({ username: "bot", url: "reg.example.com", canWrite: true });
    const registryId = regRes.body.id;

    const created = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "pushapp", serverId, image: "nginx:alpine", hostPort: 8137 })
      .expect(201);
    const rid = created.body.id;

    await request(app.getHttpServer())
      .put(`/apps/${rid}/build-config`)
      .set("Authorization", `Bearer ${token}`)
      .send({ registryId, pushToRegistry: true })
      .expect(200);
    const detail = await request(app.getHttpServer()).get(`/apps/${rid}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(detail.body.registryId).toBe(registryId);
    expect(detail.body.pushToRegistry).toBe(true);

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${rid}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    const sent = commands.join("\n");
    expect(sent).toContain(`docker push 'reg.example.com/org/tugra_${rid}:`);
    // stdin login (token never inlined into the script)
    expect(sent).toContain("docker --config \"$sd\" login 'reg.example.com' -u 'bot' --password-stdin");
    expect(sent).not.toContain("s3cr3t");
  });

  it("rolls back by pulling the registry image after the local tag is pruned", async () => {
    const regRes = await request(app.getHttpServer())
      .post("/registries")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "rbreg", teamId, type: "generic", url: "reg.example.com", username: "bot", password: "pw", imagePrefix: "org" })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "rbpush", serverId, image: "nginx:alpine", hostPort: 8140 })
      .expect(201);
    const rid = created.body.id;
    await request(app.getHttpServer())
      .put(`/apps/${rid}/build-config`)
      .set("Authorization", `Bearer ${token}`)
      .send({ registryId: regRes.body.id, pushToRegistry: true })
      .expect(200);

    // deploy → records the portable registry image on the deployment
    nextExit = 0;
    await request(app.getHttpServer()).post(`/apps/${rid}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    const dep = await prisma.deployment.findFirst({ where: { appId: rid, status: "SUCCESS" }, orderBy: { createdAt: "desc" } });
    expect(dep!.registryImage).toBe(`reg.example.com/org/tugra_${rid}:${dep!.id}`);

    // simulate a local prune: the versioned image tag is gone from the host
    await prisma.deployment.update({ where: { id: dep!.id }, data: { imageTag: null } });

    // rollback must now PULL the registry image (not rely on the pruned local tag)
    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${rid}/rollback/${dep!.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    const sent = commands.join("\n");
    expect(sent).toContain(`docker pull 'reg.example.com/org/tugra_${rid}:${dep!.id}'`);
    expect(sent).toContain(`docker tag 'reg.example.com/org/tugra_${rid}:${dep!.id}' tugra_${rid}:${dep!.id}`);
  });

  it("rejects build-config with an unknown/other-team registry (400)", async () => {
    const created = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "nocfg", serverId, image: "nginx:alpine", hostPort: 8138 })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/apps/${created.body.id}/build-config`)
      .set("Authorization", `Bearer ${token}`)
      .send({ registryId: "does-not-exist", pushToRegistry: true })
      .expect(400);
  });

  it("exposes + updates deploy strategy and reflects real zero-downtime eligibility", async () => {
    // a domain-routed app with no host port → rolling-eligible → really zero-downtime
    const created = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "zdapp", serverId, image: "nginx:alpine", domain: "zd.example.com" })
      .expect(201);
    const rid = created.body.id;
    let detail = await request(app.getHttpServer()).get(`/apps/${rid}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(detail.body.deployStrategy).toBe("ROLLING");
    expect(detail.body.rollbackOnFailure).toBe(true);
    expect(detail.body.zeroDowntime).toBe(true);

    // switch to RECREATE + disable rollback → no longer zero-downtime
    await request(app.getHttpServer())
      .put(`/apps/${rid}/deploy-settings`)
      .set("Authorization", `Bearer ${token}`)
      .send({ deployStrategy: "RECREATE", rollbackOnFailure: false })
      .expect(200);
    detail = await request(app.getHttpServer()).get(`/apps/${rid}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(detail.body.deployStrategy).toBe("RECREATE");
    expect(detail.body.rollbackOnFailure).toBe(false);
    expect(detail.body.zeroDowntime).toBe(false);
  });

  it("configures a build server (registry required, push forced on) and rejects it without a registry", async () => {
    const regRes = await request(app.getHttpServer())
      .post("/registries")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "bsreg", teamId, type: "generic", url: "reg.example.com", username: "bot", password: "pw", imagePrefix: "org" })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "bsapp", serverId, image: "nginx:alpine", hostPort: 8141 })
      .expect(201);
    const rid = created.body.id;

    // a build server without a registry is rejected
    await request(app.getHttpServer())
      .put(`/apps/${rid}/build-config`)
      .set("Authorization", `Bearer ${token}`)
      .send({ buildServerId: serverId })
      .expect(400);

    // with a registry it's accepted, and push is forced on (the deploy server pulls the image)
    await request(app.getHttpServer())
      .put(`/apps/${rid}/build-config`)
      .set("Authorization", `Bearer ${token}`)
      .send({ registryId: regRes.body.id, buildServerId: serverId })
      .expect(200);
    const detail = await request(app.getHttpServer()).get(`/apps/${rid}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(detail.body.buildServerId).toBe(serverId);
    expect(detail.body.pushToRegistry).toBe(true);
  });

  it("rejects a health-check path with shell metacharacters (400) — no injection into the probe URL", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "hcinj", serverId, image: "nginx:alpine", domain: "hcinj.example.com" })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/apps/${appRes.body.id}/health-check`)
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "HTTP", path: "/h&reboot" })
      .expect(400);
  });

  it("sets and normalizes tags on an app", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "tagapp", serverId, image: "nginx:alpine", tags: ["Web"] })
      .expect(201);
    const appId = appRes.body.id;
    expect(appRes.body.tags).toEqual(["web"]); // normalized at create

    await request(app.getHttpServer())
      .put(`/apps/${appId}/tags`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tags: ["Prod", "api", "prod", " API "] })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/apps/${appId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.tags).toEqual(["api", "prod"]);
  });

  it("lists templates (metadata only) and creates an app from one", async () => {
    const list = await request(app.getHttpServer())
      .get("/apps/templates")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const wp = list.body.find((tpl: { slug: string }) => tpl.slug === "wordpress");
    expect(wp).toBeTruthy();
    expect(wp).not.toHaveProperty("composeFile"); // gallery metadata only
    expect(wp).not.toHaveProperty("secrets");

    const created = await request(app.getHttpServer())
      .post("/apps/templates/wordpress")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "myblog", serverId })
      .expect(201);
    expect(created.body.source).toBe("COMPOSE");
    expect(created.body.composeFile).toContain("services:");

    // the generated DB secret landed in the (writer-visible) env
    const env = await request(app.getHttpServer())
      .get(`/apps/${created.body.id}/env`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(env.body.DB_PASSWORD).toBeTruthy();
  });

  it("rejects an unknown template slug (404)", async () => {
    await request(app.getHttpServer())
      .post("/apps/templates/does-not-exist")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x", serverId })
      .expect(404);
  });

  it("serves a secret-safe template manifest (typed fields, no compose without write context)", async () => {
    const res = await request(app.getHttpServer())
      .get("/apps/templates/wordpress")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.slug).toBe("wordpress");
    expect(Array.isArray(res.body.fields)).toBe(true); // typed field definitions
    expect(res.body).not.toHaveProperty("secrets");
    expect(res.body.composeFile).toBeUndefined(); // no ?serverId → compose withheld
    // with a server the caller can write to, the compose is included
    const withCompose = await request(app.getHttpServer())
      .get(`/apps/templates/wordpress?serverId=${serverId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(withCompose.body.composeFile).toContain("services:");

    await request(app.getHttpServer())
      .get("/apps/templates/does-not-exist")
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });

  it("rejects a template install whose compose override would escape the container", async () => {
    await request(app.getHttpServer())
      .post("/apps/templates/wordpress")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "evil", serverId, composeOverride: "services:\n  x:\n    image: nginx\n    privileged: true\n" })
      .expect(400);
  });

  it("stores private registry credentials without exposing the token", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "privimg", serverId, image: "reg.io/team/app:1" })
      .expect(201);
    const id = appRes.body.id;

    await request(app.getHttpServer())
      .put(`/apps/${id}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({ registry: { url: "reg.io", user: "robot", token: "supersecret" } })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/apps/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.registryUrl).toBe("reg.io");
    expect(detail.body.registryUser).toBe("robot");
    expect(JSON.stringify(detail.body)).not.toContain("supersecret");

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${id}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(150);
    const sent = commands.join("\n");
    expect(sent).toContain("--password-stdin");
    expect(sent).not.toContain("supersecret");
  });

  it("stores a private git token and uses GIT_ASKPASS on deploy", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "privrepo", serverId, source: "GIT", gitUrl: "https://github.com/acme/private.git", gitBranch: "main" })
      .expect(201);
    const id = appRes.body.id;

    await request(app.getHttpServer())
      .put(`/apps/${id}/credentials`)
      .set("Authorization", `Bearer ${token}`)
      .send({ gitToken: "ghp_supersecret" })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/apps/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.hasGitToken).toBe(true);
    expect(JSON.stringify(detail.body)).not.toContain("ghp_supersecret");

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${id}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(150);
    const sent = commands.join("\n");
    expect(sent).toContain("GIT_ASKPASS");
    expect(sent).toContain("x-access-token@github.com");
    expect(sent).not.toContain("ghp_supersecret");
  });

  it("mounts a persistent volume at deploy", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "volapp", serverId, image: "nginx:alpine", hostPort: 8133 })
      .expect(201);
    const appId = appRes.body.id;

    await request(app.getHttpServer())
      .put(`/apps/${appId}/volumes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ volumes: [{ name: "data", path: "/app/data" }] })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/apps/${appId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.volumes).toEqual([{ name: "data", path: "/app/data" }]);

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${appId}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(150);
    expect(commands.join("\n")).toContain(`-v tugra_appv_${appId}_data:/app/data`);
  });

  it("rejects an invalid volume path (400)", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "volapp2", serverId, image: "nginx:alpine" })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/apps/${appRes.body.id}/volumes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ volumes: [{ name: "data", path: "relative/path" }] })
      .expect(400);
  });

  it("sets domain options (redirect + security headers) applied as Traefik labels", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "domapp", serverId, image: "nginx:alpine", domain: "dom.example.com" })
      .expect(201);
    const appId = appRes.body.id;

    await request(app.getHttpServer())
      .put(`/apps/${appId}/domain-options`)
      .set("Authorization", `Bearer ${token}`)
      .send({ domainRedirect: "root", securityHeaders: true })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/apps/${appId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.domainRedirect).toBe("root");
    expect(detail.body.securityHeaders).toBe(true);

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${appId}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    const sent = commands.join("\n");
    expect(sent).toContain("redirectregex");
    expect(sent).toContain("Host(`www.dom.example.com`)");
    expect(sent).toContain("-sec.headers.stsSeconds");

    // central domains overview lists this domain (ssl probe best-effort)
    const dom = await request(app.getHttpServer())
      .get("/apps/domains")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const row = dom.body.find((d: { domain: string }) => d.domain === "dom.example.com");
    expect(row).toBeTruthy();
    expect(row.ssl).toHaveProperty("state");
  });

  it("remembers the template slug and exposes its logo after install", async () => {
    const listRes = await request(app.getHttpServer())
      .get("/apps/templates")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const slug = listRes.body[0].slug as string;

    const appRes = await request(app.getHttpServer())
      .post(`/apps/templates/${slug}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "from-tpl", serverId })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/apps/${appRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.templateSlug).toBe(slug);
    expect(detail.body.templateLogo).toBeTruthy();
  });

  it("assigns, exposes url for, and clears a domain after creation", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "latecomer", serverId, image: "nginx:alpine" })
      .expect(201);
    const appId = appRes.body.id;
    expect(appRes.body.url).toBeNull();

    // invalid domain rejected
    await request(app.getHttpServer())
      .put(`/apps/${appId}/domain`)
      .set("Authorization", `Bearer ${token}`)
      .send({ domain: "http://nope" })
      .expect(400);

    // assign → url is derived from the domain
    await request(app.getHttpServer())
      .put(`/apps/${appId}/domain`)
      .set("Authorization", `Bearer ${token}`)
      .send({ domain: "late.example.com" })
      .expect(200);
    let detail = await request(app.getHttpServer())
      .get(`/apps/${appId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.domain).toBe("late.example.com");
    expect(detail.body.url).toBe("https://late.example.com");

    // clear → url gone
    await request(app.getHttpServer())
      .put(`/apps/${appId}/domain`)
      .set("Authorization", `Bearer ${token}`)
      .send({ domain: null })
      .expect(200);
    detail = await request(app.getHttpServer())
      .get(`/apps/${appId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.domain).toBeNull();
    expect(detail.body.url).toBeNull();
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

  it("streams live container logs over SSE (signed log_start → log_chunk → log_exit)", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "logstream", serverId, image: "nginx:alpine", hostPort: 8141 })
      .expect(201);
    const appId = appRes.body.id;

    logStarts.length = 0;
    // follow=0 → the mock agent emits one line then exits, so the SSE completes and buffers cleanly.
    const stream = await request(app.getHttpServer())
      .get(`/apps/${appId}/logs/stream?follow=0&tail=100`)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .expect(200);

    expect(stream.text).toContain("live-log-line-1");
    // The hub derived + signed the log_start for THIS app's container over the "logs" capability.
    expect(logStarts).toHaveLength(1);
    expect(logStarts[0].target).toBe(`tugra_${appId}`);
    expect(logStarts[0].tail).toBe(100);
    expect(logStarts[0].follow).toBe(false);
    expect(typeof logStarts[0].sig).toBe("string"); // ed25519 signature attached
  });

  it("normalizes a non-numeric ?tail to a signed default (no NaN → no signature mismatch / hung stream)", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "logtail", serverId, image: "nginx:alpine", hostPort: 8144 })
      .expect(201);
    logStarts.length = 0;
    const stream = await request(app.getHttpServer())
      .get(`/apps/${appRes.body.id}/logs/stream?follow=0&tail=abc`)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .expect(200);
    // tail=abc → NaN would be signed as "NaN" but wired as null → agent would reject; the guard
    // normalizes it to 200 so the signature verifies and the stream actually emits + completes.
    expect(logStarts).toHaveLength(1);
    expect(logStarts[0].tail).toBe(200);
    expect(stream.text).toContain("live-log-line-1");
  });

  it("exports logs as a downloadable text file (one-shot docker logs with --since, attachment header)", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "logdl", serverId, image: "nginx:alpine", hostPort: 8146 })
      .expect(201);
    const appId = appRes.body.id;
    commands.length = 0;
    const res = await request(app.getHttpServer())
      .get(`/apps/${appId}/logs/download?tail=500&since=1h`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-type"]).toContain("text/plain");
    // One-shot sendCommand ran a fixed docker-logs command with the normalized since + clamped tail.
    expect(commands.join("\n")).toContain(`docker logs --timestamps --tail 500 --since 1h tugra_${appId} 2>&1`);
    expect(res.text).toContain("Up"); // the mock agent's command output
  });

  it("rejects a compose container name with shell metacharacters on download (no command injection)", async () => {
    const composeApp = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "logstack", serverId, source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx" })
      .expect(201);
    const cid = composeApp.body.id;
    commands.length = 0;
    // Belongs to the tugra_<id> project by prefix, but carries shell metacharacters → must 400.
    await request(app.getHttpServer())
      .get(`/apps/${cid}/logs/download?container=${encodeURIComponent(`tugra_${cid}-web; rm -rf /`)}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
    expect(commands.join("\n")).not.toContain("rm -rf"); // nothing reached the agent
  });

  it("forbids container-log streaming for a non-member (403, awaited authz → real status)", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "logsecure", serverId, image: "nginx:alpine", hostPort: 8142 })
      .expect(201);
    const email2 = `app-out-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
    const reg2 = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email: email2, password, name: "Outsider" })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/apps/${appRes.body.id}/logs/stream?follow=0`)
      .set("Authorization", `Bearer ${reg2.body.tokens.accessToken}`)
      .expect(403);
    const m2 = await prisma.membership.findFirst({ where: { userId: reg2.body.user.id } });
    await prisma.membership.deleteMany({ where: { userId: reg2.body.user.id } }).catch(() => undefined);
    if (m2) await prisma.team.deleteMany({ where: { id: m2.teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: email2 } }).catch(() => undefined);
  });

  it("serves per-container metrics for the app (own containers only) and 403s a non-member", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "metricsapp", serverId, image: "nginx:alpine", hostPort: 8145 })
      .expect(201);
    const appId = appRes.body.id;
    const now = Date.now();
    const base = { serverId, containerId: "abc", cpu: 1, memUsed: 1n, memTotal: 2n, memPct: 50, netRx: 0n, netTx: 0n, blkRead: 0n, blkWrite: 0n };
    await prisma.containerMetric.createMany({
      data: [
        { ...base, containerName: `tugra_${appId}`, ts: new Date(now - 1000) },
        { ...base, containerName: `tugra_${appId}`, ts: new Date(now) },
        // a DIFFERENT app's container on the same server must NOT leak into this app's metrics.
        { ...base, containerName: "tugra_someotherapp", ts: new Date(now) },
      ],
    });
    const res = await request(app.getHttpServer())
      .get(`/apps/${appId}/metrics/containers?range=1h`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.containers).toHaveLength(1);
    expect(res.body.containers[0].name).toBe(`tugra_${appId}`);
    expect(res.body.containers[0].samples.length).toBe(2);
    expect(typeof res.body.containers[0].samples[0].netRx).toBe("number");

    // A non-member gets a clean 403 (read-authz still enforces team membership).
    const email3 = `app-m-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
    const reg3 = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email: email3, password, name: "Mout" })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/apps/${appId}/metrics/containers?range=1h`)
      .set("Authorization", `Bearer ${reg3.body.tokens.accessToken}`)
      .expect(403);
    const m3 = await prisma.membership.findFirst({ where: { userId: reg3.body.user.id } });
    await prisma.membership.deleteMany({ where: { userId: reg3.body.user.id } }).catch(() => undefined);
    if (m3) await prisma.team.deleteMany({ where: { id: m3.teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: email3 } }).catch(() => undefined);
  });

  it("returns 503 for container-log streaming when the agent is offline", async () => {
    const srv = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "no-agent", teamId })
      .expect(201);
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "logoffline", serverId: srv.body.server.id, image: "nginx:alpine", hostPort: 8143 })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/apps/${appRes.body.id}/logs/stream?follow=0`)
      .set("Authorization", `Bearer ${token}`)
      .expect(503);
  });

  it("404s rollback to an unknown deployment for a compose app", async () => {
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "stack2", serverId, source: "COMPOSE", composeFile: "services: {}" })
      .expect(201);
    // Compose rollback IS supported (restores the target deploy's captured YAML snapshot), so an
    // unknown deployment id is a 404 ("no rollbackable compose configuration"), not a 400.
    await request(app.getHttpServer())
      .post(`/apps/${appRes.body.id}/rollback/whatever`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });

  it("generates an instantly-reachable magic domain when the server has a public IP", async () => {
    // The e2e agent dials in from loopback, so no public IP is observed — set one
    // directly to exercise the magic-domain path end to end.
    await prisma.server.update({ where: { id: serverId }, data: { publicIp: "203.0.113.7" } });
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Magic Web", serverId, image: "nginx:alpine" }) // exposeMode defaults to "magic"
      .expect(201);
    expect(appRes.body.domainKind).toBe("magic");
    expect(appRes.body.certType).toBe("http");
    expect(appRes.body.domain).toMatch(/^magic-web-[0-9a-f]{6}\.203-0-113-7\.sslip\.io$/);
    expect(appRes.body.url).toBe(`http://${appRes.body.domain}`);
  });

  it("re-exposes an existing app via PUT /apps/:id/expose", async () => {
    // The server has a public IP (set in the test above). Create domainless, then expose as magic.
    const created = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Reexpose Me", serverId, image: "nginx:alpine", exposeMode: "none" })
      .expect(201);
    expect(created.body.domain).toBeNull();
    const exposed = await request(app.getHttpServer())
      .put(`/apps/${created.body.id}/expose`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mode: "magic" })
      .expect(200);
    expect(exposed.body.domainKind).toBe("magic");
    expect(exposed.body.url).toMatch(/^http:\/\/reexpose-me-[0-9a-f]{6}\.203-0-113-7\.sslip\.io$/);
    // custom mode requires a domain
    await request(app.getHttpServer())
      .put(`/apps/${created.body.id}/expose`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mode: "custom" })
      .expect(400);
  });

  it("deploys a routed app zero-downtime (rolling) and auto-rolls-back on a failed health gate (exit 3)", async () => {
    const created = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Rolling", serverId, image: "nginx:alpine", domain: "rolling.example.com" })
      .expect(201);
    const rid = created.body.id;

    // healthy deploy → the rolling builder (temp __rollout container + health gate)
    commands.length = 0;
    nextExit = 0;
    await request(app.getHttpServer()).post(`/apps/${rid}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    const sent = commands.join("\n");
    expect(sent).toContain(`docker run -d --name tugra_${rid}__rollout`);
    expect(sent).toContain("TUGRA_ROLLOUT"); // the health gate / cutover logic is present
    expect(sent).toContain(`docker rename tugra_${rid}__rollout tugra_${rid}`);

    // failed health gate (exit 3) → previous version kept: app stays RUNNING, deployment AUTO_ROLLBACK
    nextExit = 3;
    await request(app.getHttpServer()).post(`/apps/${rid}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    nextExit = 0; // reset for any later tests
    const appAfter = await request(app.getHttpServer()).get(`/apps/${rid}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(appAfter.body.status).toBe("RUNNING");
    const deps = await request(app.getHttpServer()).get(`/apps/${rid}/deployments`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(deps.body[0].kind).toBe("AUTO_ROLLBACK");
    expect(deps.body[0].status).toBe("FAILED");
  });

  it("deploys a host-port app via recreate and auto-rolls-back on a failed health gate (exit 3)", async () => {
    const created = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Recreate", serverId, image: "nginx:alpine", hostPort: 8134 })
      .expect(201);
    const rid = created.body.id;

    // healthy first deploy → recreate on the canonical name (NO temp rollout) + records a
    // SUCCESS deployment whose image becomes the rollback target for the next attempt.
    commands.length = 0;
    nextExit = 0;
    await request(app.getHttpServer()).post(`/apps/${rid}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    const sent = commands.join("\n");
    expect(sent).toContain(`docker run -d --name tugra_${rid}`);
    expect(sent).not.toContain("__rollout"); // host-port → recreate, not rolling
    expect(sent).toContain("TUGRA_ROLLOUT"); // health gate present

    // failed health gate (exit 3) with a previous version → auto-rollback, app stays RUNNING
    nextExit = 3;
    await request(app.getHttpServer()).post(`/apps/${rid}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    nextExit = 0; // reset for any later tests
    const appAfter = await request(app.getHttpServer()).get(`/apps/${rid}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(appAfter.body.status).toBe("RUNNING");
    const deps = await request(app.getHttpServer()).get(`/apps/${rid}/deployments`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(deps.body[0].kind).toBe("AUTO_ROLLBACK");
    expect(deps.body[0].status).toBe("FAILED");
  });

  it("gives a one-click Compose/template app an instant magic domain routed via a label override", async () => {
    // server already has publicIp 203.0.113.7 from the earlier magic test
    const inst = await request(app.getHttpServer())
      .post("/apps/templates/wordpress")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Blog", serverId })
      .expect(201);
    expect(inst.body.source).toBe("COMPOSE");
    expect(inst.body.domainKind).toBe("magic");
    expect(inst.body.domain).toMatch(/^blog-[0-9a-f]{6}\.203-0-113-7\.sslip\.io$/);

    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${inst.body.id}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    // Fire-and-forget deploy: wait for the override-layered compose command to land (not a fixed sleep).
    await waitForCommand(commands, `/etc/tugra/compose/${inst.body.id}/docker-compose.tugra.yml`);
    const sent = commands.join("\n");
    // the compose deploy layers a Traefik label override joining the web service to the proxy
    expect(sent).toContain(
      `-f /etc/tugra/compose/${inst.body.id}/docker-compose.yml -f /etc/tugra/compose/${inst.body.id}/docker-compose.tugra.yml`,
    );
    // decode the override file to confirm the router labels + proxy network
    const m = sent.match(
      new RegExp(`printf %s '([A-Za-z0-9+/=]+)' \\| base64 -d > /etc/tugra/compose/${inst.body.id}/docker-compose\\.tugra\\.yml`),
    );
    expect(m).toBeTruthy();
    const yaml = Buffer.from(m![1], "base64").toString();
    expect(yaml).toContain("traefik.enable=true");
    expect(yaml).toContain(`Host(\`${inst.body.domain}\`)`);
    expect(yaml).toContain("- tugra-proxy");
  });

  // Runs LAST — it mutates the shared server's capabilities and restores them at the end.
  it("enforces per-server capability grants (deploy blocked when revoked) + rejects invalid caps", async () => {
    // a server created via POST /servers defaults to all-except-terminal (least privilege)
    const d0 = await request(app.getHttpServer()).get(`/servers/${serverId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(d0.body.capabilities).not.toContain("terminal");

    // an unknown capability is rejected
    await request(app.getHttpServer())
      .put(`/servers/${serverId}/capabilities`)
      .set("Authorization", `Bearer ${token}`)
      .send({ capabilities: ["bogus"] })
      .expect(400);

    // revoke deploy → a deploy to this server is refused hub-side (never signed/sent)
    await request(app.getHttpServer())
      .put(`/servers/${serverId}/capabilities`)
      .set("Authorization", `Bearer ${token}`)
      .send({ capabilities: ["backup", "cleanup"] })
      .expect(200);
    const created = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "capblock", serverId, image: "nginx:alpine", hostPort: 8142 })
      .expect(201);
    nextExit = 0;
    await request(app.getHttpServer()).post(`/apps/${created.body.id}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    const deps = await request(app.getHttpServer()).get(`/apps/${created.body.id}/deployments`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(deps.body[0].status).toBe("FAILED");
    expect((deps.body[0].logs ?? "").toLowerCase()).toContain("capability");

    // restore full capabilities (stored verbatim — [] would mean deny-all, not "all") so
    // nothing else is affected
    await request(app.getHttpServer())
      .put(`/servers/${serverId}/capabilities`)
      .set("Authorization", `Bearer ${token}`)
      .send({ capabilities: ["deploy", "database", "backup", "cleanup", "bulk", "terminal", "schedule", "patch"] })
      .expect(200);
    const restored = await request(app.getHttpServer()).get(`/servers/${serverId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(restored.body.capabilities).toContain("terminal");
    expect(restored.body.capabilities).toHaveLength(8);
  });
});
