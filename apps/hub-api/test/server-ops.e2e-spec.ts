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

  it("checks proxy status, restarts it, and tails logs via the agent", async () => {
    commands.length = 0;
    await request(app.getHttpServer())
      .get(`/servers/${serverId}/proxy`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/servers/${serverId}/proxy/restart`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/servers/${serverId}/proxy/logs?tail=50`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(60);
    const joined = commands.join("\n");
    expect(joined).toContain("docker inspect -f '{{.State.Status}}' tugra-proxy");
    expect(joined).toContain("docker restart tugra-proxy");
    expect(joined).toContain("docker logs --tail 50 tugra-proxy");
  });

  it("configures DNS-01 and sets up the proxy with the le-dns resolver — creds never leak in plaintext", async () => {
    await request(app.getHttpServer())
      .put(`/servers/${serverId}/network`)
      .set("Authorization", `Bearer ${token}`)
      .send({ certMode: "le-dns", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "s3cr3t-token" }, wildcardDomain: "apps.example.com" })
      .expect(200);
    // GET never returns the creds — only whether they're configured
    const got = await request(app.getHttpServer())
      .get(`/servers/${serverId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(got.body.certMode).toBe("le-dns");
    expect(got.body.hasDnsCreds).toBe(true);
    expect(JSON.stringify(got.body)).not.toContain("s3cr3t-token");
    expect(got.body.dnsCredsEnc).toBeUndefined();

    commands.length = 0;
    await request(app.getHttpServer()).post(`/servers/${serverId}/proxy/start`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(60);
    const joined = commands.join("\n");
    expect(joined).toContain("--certificatesresolvers.le-dns.acme.dnschallenge.provider='cloudflare'");
    expect(joined).toContain("--env-file /etc/tugra/proxy/dns.env");
    // SECURITY: the token appears ONLY base64'd in the env-file write, never as -e / plaintext argv
    expect(joined).not.toContain("-e CF_DNS_API_TOKEN");
    expect(joined).not.toContain("s3cr3t-token");
  });
});
