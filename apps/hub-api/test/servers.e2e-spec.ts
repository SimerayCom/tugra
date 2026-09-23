import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Servers + Agent (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `srv-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let accessToken = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0); // real port so the agent WS works
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "Srv" })
      .expect(201);
    accessToken = reg.body.tokens.accessToken;
    const membership = await prisma.membership.findFirst({
      where: { userId: reg.body.user.id },
    });
    teamId = membership!.teamId;
  });

  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  let serverId = "";
  let enrollToken = "";

  it("creates a server (PENDING) and returns an enroll token", async () => {
    const res = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "web-1", teamId })
      .expect(201);
    expect(res.body.enrollToken).toMatch(/^tugra_en_/);
    // install command is built from the request host, no manual placeholder
    expect(res.body.installCommand).toContain("/agent");
    expect(res.body.installCommand).not.toContain("<YOUR_HUB_URL>");
    serverId = res.body.server.id;
    enrollToken = res.body.enrollToken;
  });

  it("lists the server cross-team with canWrite=true (OWNER)", async () => {
    const res = await request(app.getHttpServer())
      .get("/servers")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const found = res.body.find((s: { id: string }) => s.id === serverId);
    expect(found).toBeTruthy();
    expect(found.canWrite).toBe(true);
    expect(found.status).toBe("PENDING");
  });

  it("sets and normalizes tags on a server", async () => {
    await request(app.getHttpServer())
      .put(`/servers/${serverId}/tags`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ tags: ["EU", "edge", "eu"] })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/servers/${serverId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.tags).toEqual(["edge", "eu"]);
  });

  it("sets per-server network settings (wildcard domain + manual public IP)", async () => {
    await request(app.getHttpServer())
      .put(`/servers/${serverId}/network`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ wildcardDomain: "apps.example.com", publicIp: "203.0.113.7" })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/servers/${serverId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.wildcardDomain).toBe("apps.example.com");
    expect(res.body.publicIp).toBe("203.0.113.7");
    expect(res.body.ipSource).toBe("manual");
  });

  it("rejects a private manual IP", async () => {
    await request(app.getHttpServer())
      .put(`/servers/${serverId}/network`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ publicIp: "10.0.0.5" })
      .expect(400);
  });

  it("manages log drains for a server (create + list)", async () => {
    const created = await request(app.getHttpServer())
      .post(`/servers/${serverId}/log-drains`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "axiom", endpoint: "https://logs.example.com/ingest", token: "secret" })
      .expect(201);
    expect(created.body.name).toBe("axiom");
    expect(created.body.hasToken).toBe(true);
    expect(created.body.token).toBeUndefined(); // secret never returned

    const list = await request(app.getHttpServer())
      .get(`/servers/${serverId}/log-drains`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(list.body.some((d: { id: string }) => d.id === created.body.id)).toBe(true);

    await request(app.getHttpServer())
      .delete(`/servers/${serverId}/log-drains/${created.body.id}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
  });

  it("returns the install command for a PENDING server via :id/install", async () => {
    const res = await request(app.getHttpServer())
      .get(`/servers/${serverId}/install`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.installCommand).toContain("/agent");
    expect(res.body.installCommand).toContain("tugra_en_");
  });

  it("reissues a fresh enroll command for a PENDING server", async () => {
    const res = await request(app.getHttpServer())
      .post(`/servers/${serverId}/reissue`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.installCommand).toMatch(/tugra_en_/);
    // the reissued token replaces the old one — enroll below uses the latest
    enrollToken = res.body.installCommand.split("--token ")[1].trim();
  });

  it("enrolls an agent over WS, goes ONLINE, and ingests metrics", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const spkiB64 = publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    const enrolled = await new Promise<{ serverId: string; seal: string }>(
      (resolve, reject) => {
        ws.on("error", reject);
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "challenge") {
            ws.send(
              JSON.stringify({
                type: "enroll",
                protocol: 1,
                token: enrollToken,
                publicKey: spkiB64,
                agentVersion: "e2e",
                hostname: "e2e-host",
                fingerprint: "fp",
              }),
            );
          } else if (msg.type === "enrolled") {
            resolve(msg);
          } else if (msg.type === "error") {
            reject(new Error(msg.message));
          }
        });
      },
    );
    expect(enrolled.serverId).toBe(serverId);
    expect(enrolled.seal).toMatch(/^seal_/);

    // push a metrics sample
    ws.send(
      JSON.stringify({
        type: "metrics",
        sample: {
          ts: Date.now(),
          cpu: 42.5,
          memUsed: 1000,
          memTotal: 2000,
          diskUsed: 10,
          diskTotal: 100,
          netRx: 5,
          netTx: 7,
        },
      }),
    );

    // push host inventory (sent by the agent after auth)
    const bootTime = Math.floor(Date.now() / 1000) - 3600; // booted 1h ago
    ws.send(
      JSON.stringify({
        type: "host_info",
        info: {
          os: "ubuntu",
          osVersion: "24.04",
          arch: "x86_64",
          kernel: "6.8.0-90-generic",
          cpuCores: 4,
          memTotalBytes: 8589934592,
          bootTime,
        },
      }),
    );
    await sleep(400);

    const detail = await request(app.getHttpServer())
      .get(`/servers/${serverId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(detail.body.status).toBe("ONLINE");
    expect(detail.body.os).toBe("ubuntu");
    expect(detail.body.arch).toBe("x86_64");
    expect(detail.body.cpuCores).toBe(4);
    expect(detail.body.memTotalBytes).toBe("8589934592");
    expect(detail.body.uptimeSeconds).toBeGreaterThanOrEqual(3500);

    const metrics = await request(app.getHttpServer())
      .get(`/servers/${serverId}/metrics`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(metrics.body.length).toBeGreaterThanOrEqual(1);
    expect(metrics.body[metrics.body.length - 1].cpu).toBe(42.5);

    // server patching: reply to the patch command with a real apt-format output
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "command") {
        ws.send(
          JSON.stringify({
            type: "command_result",
            reqId: msg.reqId,
            exitCode: 0,
            output: "TUGRA_MGR=apt\nTUGRA_UPGRADABLE\nListing...\ndocker-ce/noble 5:29.6.0 amd64 [upgradable from: 5:29.5.0]\nTUGRA_REBOOT\n",
          }),
        );
      }
    });
    const updates = await request(app.getHttpServer())
      .get(`/servers/${serverId}/updates`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(updates.body.supported).toBe(true);
    expect(updates.body.count).toBe(1);
    expect(updates.body.rebootRequired).toBe(true);
    expect(updates.body.packages[0].name).toBe("docker-ce");

    ws.close();
  });

  it("stops revealing the install command once ONLINE and refuses reissue", async () => {
    const inst = await request(app.getHttpServer())
      .get(`/servers/${serverId}/install`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(inst.body.status).toBe("ONLINE");
    expect(inst.body.installCommand).toBeNull();
    await request(app.getHttpServer())
      .post(`/servers/${serverId}/reissue`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(409);
  });

  it("rejects an agent with a bad enroll token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    const err = await new Promise<string>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge") {
          ws.send(
            JSON.stringify({
              type: "enroll",
              protocol: 1,
              token: "tugra_en_bogus",
              publicKey: "k",
              agentVersion: "e2e",
              hostname: "e2e",
              fingerprint: "fp",
            }),
          );
        } else if (msg.type === "error") {
          resolve(msg.message);
        }
      });
    });
    expect(err).toMatch(/invalid or expired|rejected/);
    ws.close();
  });
});
