import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("Terminal (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `term-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let agent: WebSocket;
  let serverId = "";
  let appId = "";
  let composeAppId = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "Term" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "term-node", teamId })
      .expect(201);
    serverId = created.body.server.id;
    const enrollToken = created.body.enrollToken;
    const { publicKey } = generateKeyPairSync("ed25519");
    const spkiB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "shellapp", serverId, image: "nginx:alpine" })
      .expect(201);
    appId = appRes.body.id;

    const composeRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "stack", serverId, source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx" })
      .expect(201);
    composeAppId = composeRes.body.id;

    // Agent simulator: a PTY-less echo shell driven by the term_* protocol.
    agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    await new Promise<void>((resolve, reject) => {
      agent.on("error", reject);
      agent.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge") {
          agent.send(JSON.stringify({ type: "enroll", protocol: 1, token: enrollToken, publicKey: spkiB64, agentVersion: "e2e", hostname: "h", fingerprint: "f" }));
        } else if (msg.type === "enrolled") {
          resolve();
        } else if (msg.type === "term_start") {
          agent.send(JSON.stringify({ type: "term_output", sessionId: msg.sessionId, data: b64(`shell:${msg.target}\n`) }));
        } else if (msg.type === "term_input") {
          // echo stdin back as output
          const text = Buffer.from(msg.data, "base64").toString();
          agent.send(JSON.stringify({ type: "term_output", sessionId: msg.sessionId, data: b64(`echo:${text}`) }));
        } else if (msg.type === "term_close") {
          agent.send(JSON.stringify({ type: "term_exit", sessionId: msg.sessionId, exitCode: 0 }));
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

  function collect(ws: WebSocket): { lines: () => string } {
    let buf = "";
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "term_output") buf += Buffer.from(m.data, "base64").toString();
    });
    return { lines: () => buf };
  }

  it("opens a host shell and relays output + echoed input", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?server=${serverId}`, ["tugra.bearer", token]);
    const got = collect(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await sleep(120);
    expect(got.lines()).toContain("shell:"); // host → target ""

    ws.send(JSON.stringify({ type: "term_input", data: b64("ls\n") }));
    await sleep(120);
    expect(got.lines()).toContain("echo:ls");
    ws.close();
  });

  it("opens a container shell targeting tugra_<appId>", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?app=${appId}`, ["tugra.bearer", token]);
    const got = collect(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await sleep(120);
    expect(got.lines()).toContain(`shell:tugra_${appId}`);
    ws.close();
  });

  it("opens a compose container shell targeting the chosen service", async () => {
    const c = `tugra_${composeAppId}-web-1`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?app=${composeAppId}&container=${c}`, ["tugra.bearer", token]);
    const got = collect(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await sleep(120);
    expect(got.lines()).toContain(`shell:${c}`);
    ws.close();
  });

  it("rejects a compose terminal targeting a foreign container (close 1008)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?app=${composeAppId}&container=tugra_other-db-1`, ["tugra.bearer", token]);
    const code = await new Promise<number>((resolve) => {
      ws.on("open", () => ws.send(""));
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => undefined);
    });
    expect(code).toBe(1008);
  });

  it("rejects a connection with an invalid token (close 1008)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?server=${serverId}`, ["tugra.bearer", "garbage"]);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => undefined);
    });
    expect(code).toBe(1008);
  });
});
