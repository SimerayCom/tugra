import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHmac, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Webhooks / auto-deploy (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `wh-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let agent: WebSocket;
  let serverId = "";
  let appId = "";
  let webhookToken = "";
  let webhookSecret = "";
  const commands: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "WH" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "wh-node", teamId })
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

    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "gitapp", serverId, source: "GIT", gitUrl: "https://github.com/u/r.git", gitBranch: "main" })
      .expect(201);
    appId = appRes.body.id;
    webhookToken = appRes.body.webhookToken;
    webhookSecret = appRes.body.webhookSecret;
  });

  afterAll(async () => {
    agent?.close();
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("exposes a webhook token + secret to the owner", () => {
    expect(webhookToken).toMatch(/^tugra_wh_/);
    expect(typeof webhookSecret).toBe("string");
    expect(webhookSecret.length).toBeGreaterThan(20);
  });

  it("rejects a push with the wrong secret (401)", async () => {
    await request(app.getHttpServer())
      .post(`/webhooks/deploy/${webhookToken}`)
      .set("X-Gitlab-Token", "wrong-secret")
      .send({ ref: "refs/heads/main" })
      .expect(401);
  });

  it("ignores a push to a non-tracked branch (202, no deploy)", async () => {
    const before = (await request(app.getHttpServer()).get(`/apps/${appId}/deployments`).set("Authorization", `Bearer ${token}`)).body.length;
    const res = await request(app.getHttpServer())
      .post(`/webhooks/deploy/${webhookToken}`)
      .set("X-Gitlab-Token", webhookSecret)
      .send({ ref: "refs/heads/other" })
      .expect(202);
    expect(res.body.deployed).toBe(false);
    await sleep(150);
    const after = (await request(app.getHttpServer()).get(`/apps/${appId}/deployments`).set("Authorization", `Bearer ${token}`)).body.length;
    expect(after).toBe(before);
  });

  it("deploys on a GitLab-token push to the tracked branch", async () => {
    commands.length = 0;
    const res = await request(app.getHttpServer())
      .post(`/webhooks/deploy/${webhookToken}`)
      .set("X-Gitlab-Token", webhookSecret)
      .send({ ref: "refs/heads/main" })
      .expect(202);
    expect(res.body.deployed).toBe(true);
    await sleep(300);

    const deployments = await request(app.getHttpServer())
      .get(`/apps/${appId}/deployments`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(deployments.body[0].status).toBe("SUCCESS");
    expect(commands.join("\n")).toContain("git clone");
  });

  it("deploys on a valid GitHub HMAC signature", async () => {
    commands.length = 0;
    const payload = { ref: "refs/heads/main" };
    const body = JSON.stringify(payload);
    const sig = "sha256=" + createHmac("sha256", webhookSecret).update(body).digest("hex");
    const res = await request(app.getHttpServer())
      .post(`/webhooks/deploy/${webhookToken}`)
      .set("X-Hub-Signature-256", sig)
      .set("Content-Type", "application/json")
      .send(body)
      .expect(202);
    expect(res.body.deployed).toBe(true);
    await sleep(300);
    expect(commands.join("\n")).toContain("git clone");
  });

  describe("preview deployments (PR events)", () => {
    let pvId = "";
    let pvToken = "";
    let pvSecret = "";
    const auth = () => ["Authorization", `Bearer ${token}`] as const;
    const prBody = (action: string, number: number, ref: string) =>
      JSON.stringify({ action, pull_request: { number, head: { ref } } });
    const ghSig = (secret: string, body: string) =>
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post("/apps")
        .set(...auth())
        .send({ name: "pvapp", serverId, source: "GIT", gitUrl: "https://github.com/u/r.git", domain: "app.example.com" })
        .expect(201);
      pvId = res.body.id;
      pvToken = res.body.webhookToken;
      pvSecret = res.body.webhookSecret;
      await request(app.getHttpServer())
        .put(`/apps/${pvId}/preview-config`)
        .set(...auth())
        .send({ enabled: true })
        .expect(200);
    });

    it("refuses enabling previews on an app without a domain (400)", async () => {
      await request(app.getHttpServer())
        .put(`/apps/${appId}/preview-config`)
        .set(...auth())
        .send({ enabled: true })
        .expect(400);
    });

    it("creates a preview clone on PR opened, under pr<n>.<domain>", async () => {
      commands.length = 0;
      const body = prBody("opened", 7, "feature-7");
      const res = await request(app.getHttpServer())
        .post(`/webhooks/deploy/${pvToken}`)
        .set("X-GitHub-Event", "pull_request")
        .set("X-Hub-Signature-256", ghSig(pvSecret, body))
        .set("Content-Type", "application/json")
        .send(body)
        .expect(202);
      expect(res.body.deployed).toBe(true);
      await sleep(400);

      const previews = await request(app.getHttpServer())
        .get(`/apps/${pvId}/previews`)
        .set(...auth())
        .expect(200);
      expect(previews.body).toHaveLength(1);
      expect(previews.body[0].prNumber).toBe(7);
      expect(previews.body[0].isPreview).toBe(true);
      expect(previews.body[0].gitBranch).toBe("feature-7");
      expect(previews.body[0].domain).toBe("pr7.app.example.com");
      expect(commands.join("\n")).toContain("git clone");
      // Preview apps never appear in the top-level app list.
      const list = await request(app.getHttpServer()).get("/apps").set(...auth()).expect(200);
      expect(list.body.some((a: { prNumber?: number }) => a.prNumber === 7)).toBe(false);
    });

    it("tears the preview down on PR closed", async () => {
      const body = prBody("closed", 7, "feature-7");
      await request(app.getHttpServer())
        .post(`/webhooks/deploy/${pvToken}`)
        .set("X-GitHub-Event", "pull_request")
        .set("X-Hub-Signature-256", ghSig(pvSecret, body))
        .set("Content-Type", "application/json")
        .send(body)
        .expect(202);
      await sleep(400);
      const previews = await request(app.getHttpServer())
        .get(`/apps/${pvId}/previews`)
        .set(...auth())
        .expect(200);
      expect(previews.body).toHaveLength(0);
    });

    it("ignores PR events when previews are disabled on the app", async () => {
      const body = prBody("opened", 9, "feature-9");
      const res = await request(app.getHttpServer())
        .post(`/webhooks/deploy/${webhookToken}`)
        .set("X-GitHub-Event", "pull_request")
        .set("X-Hub-Signature-256", ghSig(webhookSecret, body))
        .set("Content-Type", "application/json")
        .send(body)
        .expect(202);
      expect(res.body.deployed).toBe(false);
    });
  });
});
