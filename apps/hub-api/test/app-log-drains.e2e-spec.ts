import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Per-app log drains (D7) against a real DB + a mock agent that advertises `log_drains_v2` and records the frames
// the hub pushes. NOTE: written to run in CI with a Postgres (like every *.e2e-spec.ts); it was authored where no
// database was available, so it has not been executed locally.
describe("App log drains (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `ald-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let jwt = "";
  let serverId = "";
  let appId = "";
  let agent: WebSocket;
  const frames: Record<string, unknown>[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const waitForFrame = async (pred: (m: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = [...frames].reverse().find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    throw new Error("timed out waiting for an agent frame");
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password, name: "ALD" }).expect(201);
    jwt = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer()).post("/servers").set(auth(jwt)).send({ name: "drain-node", teamId }).expect(201);
    serverId = created.body.server.id;
    const { publicKey } = generateKeyPairSync("ed25519");
    const spkiB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    await new Promise<void>((resolve, reject) => {
      agent.on("error", reject);
      agent.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge") {
          agent.send(
            JSON.stringify({
              type: "enroll", protocol: 2, token: created.body.enrollToken, publicKey: spkiB64, agentVersion: "e2e", hostname: "h", fingerprint: "f",
              features: ["log_drains_v2", "log_drain_syslog_v1", "log_drain_gelf_v1", "log_drain_fluentd_v1"],
            }),
          );
        } else if (msg.type === "enrolled") {
          resolve();
        } else if (msg.type === "command") {
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode: 0, output: "" }));
        }
        if (msg.type === "log_drains" || msg.type === "log_drains_v2") frames.push(msg);
      });
    });

    const appRes = await request(app.getHttpServer()).post("/apps").set(auth(jwt)).send({ name: "shop", serverId, image: "nginx:alpine", hostPort: 8081 }).expect(201);
    appId = appRes.body.id;
  });

  afterAll(async () => {
    agent?.close();
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  let drainId = "";

  it("creates an app drain (CRUD: create), never returns the token, and pushes a signed v2 frame to the agent", async () => {
    const res = await request(app.getHttpServer())
      .post(`/apps/${appId}/log-drains`)
      .set(auth(jwt))
      .send({ name: "axiom", type: "loki", endpoint: "https://logs.example.com/loki/api/v1/push", token: "s3cret" })
      .expect(201);
    drainId = res.body.id;
    expect(res.body).toMatchObject({ name: "axiom", type: "loki", scope: "app", appId, hasToken: true, containers: [], allowPrivate: false });
    expect(res.body.token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("s3cret");

    const frame = await waitForFrame((m) => m.type === "log_drains_v2" && String(m.drainsJson).includes(drainId));
    expect(frame.serverId).toBe(serverId);
    expect(frame.capability).toBe("logs");
    expect(typeof frame.sig).toBe("string");
    const drains = JSON.parse(frame.drainsJson as string) as { id: string; scope?: string; appId?: string; egress?: string; token: string }[];
    const d = drains.find((x) => x.id === drainId)!;
    expect(d).toMatchObject({ scope: "app", appId, egress: "public", token: "s3cret" });
  });

  it("lists the app's drains (CRUD: read) with a delivery state, and updates + re-pushes (CRUD: update)", async () => {
    const list = await request(app.getHttpServer()).get(`/apps/${appId}/log-drains`).set(auth(jwt)).expect(200);
    expect(list.body.map((d: { id: string }) => d.id)).toContain(drainId);
    expect(list.body[0]).toHaveProperty("delivery");

    const upd = await request(app.getHttpServer()).put(`/apps/${appId}/log-drains/${drainId}`).set(auth(jwt)).send({ enabled: false }).expect(200);
    expect(upd.body.enabled).toBe(false);
    const frame = await waitForFrame((m) => m.type === "log_drains_v2" && !String(m.drainsJson).includes(drainId));
    expect(frame).toBeTruthy();
    await request(app.getHttpServer()).put(`/apps/${appId}/log-drains/${drainId}`).set(auth(jwt)).send({ enabled: true }).expect(200);
  });

  it("GET needs read:secrets for a PAT (a plain read PAT is refused); a read:secrets PAT is allowed", async () => {
    const mint = async (scopes: string[]) =>
      (await request(app.getHttpServer()).post("/api-tokens").set(auth(jwt)).send({ name: `ald-${scopes.join("-")}`, scopes }).expect(201)).body.token as string;
    const read = await mint(["read"]);
    const denied = await request(app.getHttpServer()).get(`/apps/${appId}/log-drains`).set(auth(read));
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe("insufficient token scope");
    const secrets = await mint(["read:secrets"]);
    await request(app.getHttpServer()).get(`/apps/${appId}/log-drains`).set(auth(secrets)).expect(200);
  });

  it("refuses private and metadata endpoints without allowPrivate, and a container filter on a non-compose app", async () => {
    await request(app.getHttpServer()).post(`/apps/${appId}/log-drains`).set(auth(jwt))
      .send({ name: "lan", type: "http", endpoint: "http://10.0.0.5:3100/x" }).expect(400);
    await request(app.getHttpServer()).post(`/apps/${appId}/log-drains`).set(auth(jwt))
      .send({ name: "imds", type: "http", endpoint: "http://169.254.169.254/latest" }).expect(400);
    await request(app.getHttpServer()).post(`/apps/${appId}/log-drains`).set(auth(jwt))
      .send({ name: "svc", type: "http", endpoint: "https://logs.example.com/x", containers: ["web"] }).expect(400);
    await request(app.getHttpServer()).post(`/apps/${appId}/log-drains`).set(auth(jwt))
      .send({ name: "sys", type: "syslog", endpoint: "syslog.example.com:514" }).expect(400); // options required
  });

  it("scopes never cross: server routes 404 an app drain, app routes 404 a server-wide drain", async () => {
    await request(app.getHttpServer()).put(`/servers/${serverId}/log-drains/${drainId}`).set(auth(jwt)).send({ name: "hijack" }).expect(404);
    await request(app.getHttpServer()).delete(`/servers/${serverId}/log-drains/${drainId}`).set(auth(jwt)).expect(404);
    const srv = await request(app.getHttpServer()).get(`/servers/${serverId}/log-drains`).set(auth(jwt)).expect(200);
    expect(srv.body.map((d: { id: string }) => d.id)).not.toContain(drainId); // the server list is server-wide only

    const wide = await request(app.getHttpServer()).post(`/servers/${serverId}/log-drains`).set(auth(jwt))
      .send({ name: "wide", endpoint: "https://wide.example.com/in" }).expect(201);
    await request(app.getHttpServer()).put(`/apps/${appId}/log-drains/${wide.body.id}`).set(auth(jwt)).send({ name: "x" }).expect(404);
    await request(app.getHttpServer()).delete(`/apps/${appId}/log-drains/${wide.body.id}`).set(auth(jwt)).expect(404);

    // the operator's view of app drains on this server carries no endpoint/options/token
    const sum = await request(app.getHttpServer()).get(`/servers/${serverId}/log-drains/apps`).set(auth(jwt)).expect(200);
    const mine = sum.body.find((d: { id: string }) => d.id === drainId);
    expect(mine).toMatchObject({ appId, appName: "shop", type: "loki" });
    expect(mine).not.toHaveProperty("endpoint");
    expect(mine).not.toHaveProperty("options");
    expect(JSON.stringify(sum.body)).not.toContain("s3cret");
    await request(app.getHttpServer()).delete(`/servers/${serverId}/log-drains/${wide.body.id}`).set(auth(jwt)).expect(200);
  });

  it("deletes a drain (CRUD: delete) and cascades every app drain away when the app is deleted", async () => {
    await request(app.getHttpServer()).delete(`/apps/${appId}/log-drains/${drainId}`).set(auth(jwt)).expect(200);
    expect(await prisma.logDrain.count({ where: { appId } })).toBe(0);

    await request(app.getHttpServer()).post(`/apps/${appId}/log-drains`).set(auth(jwt))
      .send({ name: "again", type: "http", endpoint: "https://logs.example.com/again" }).expect(201);
    expect(await prisma.logDrain.count({ where: { appId } })).toBe(1);
    await request(app.getHttpServer()).delete(`/apps/${appId}`).set(auth(jwt)).expect(200);
    expect(await prisma.logDrain.count({ where: { appId } })).toBe(0); // onDelete: Cascade
    // the agent was told: the last v2 frame no longer carries the app's drain
    const last = await waitForFrame((m) => m.type === "log_drains_v2" && !String(m.drainsJson).includes("again"));
    expect(last).toBeTruthy();
  });
});
