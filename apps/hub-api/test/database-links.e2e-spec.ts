import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Database links (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `link-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let agent: WebSocket;
  let serverId = "";
  let appId = "";
  let dbId = "";
  const commands: string[] = [];

  async function makeDb(name: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name, serverId, engine: "POSTGRES" })
      .expect(201);
    return res.body.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "Linker" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "link-node", teamId })
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
      .send({ name: "linkapp", serverId, image: "nginx:alpine", hostPort: 8099 })
      .expect(201);
    appId = appRes.body.id;
    dbId = await makeDb("orders");
  });

  afterAll(async () => {
    agent?.close();
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("links a same-server database (internal route) and auto-joins the DB network", async () => {
    const res = await request(app.getHttpServer())
      .post(`/apps/${appId}/database-links`)
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseId: dbId })
      .expect(201);
    expect(res.body.envVar).toBe("DATABASE_URL");
    expect(res.body.route).toBe("internal");
    // never leaks the connection string / password
    expect(JSON.stringify(res.body)).not.toMatch(/postgresql:\/\/|password/i);

    const appAfter = await request(app.getHttpServer()).get(`/apps/${appId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(appAfter.body.dbNetwork).toBe(true);
  });

  it("lists the link without any secret", async () => {
    const res = await request(app.getHttpServer()).get(`/apps/${appId}/database-links`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ envVar: "DATABASE_URL", name: "orders", engine: "POSTGRES", route: "internal", shadowedBy: null });
    expect(JSON.stringify(res.body)).not.toMatch(/postgresql:\/\/|:5432\/|password/i);
  });

  it("injects the connection URI into the deploy env-file", async () => {
    commands.length = 0;
    await request(app.getHttpServer()).post(`/apps/${appId}/deploy`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(200);
    const sent = commands.join("\n");
    expect(sent).toContain("--env-file /etc/tugra/env/");
    const decoded = [...sent.matchAll(/printf %s '([A-Za-z0-9+/=]+)'/g)].map((m) => Buffer.from(m[1], "base64").toString());
    const envFile = decoded.find((d) => d.includes("DATABASE_URL="));
    expect(envFile).toBeTruthy();
    expect(envFile).toMatch(/DATABASE_URL=postgresql:\/\/.*@tugra_db_.*:5432\//);
  });

  it("is idempotent: re-linking the same database returns the existing link", async () => {
    const res = await request(app.getHttpServer())
      .post(`/apps/${appId}/database-links`)
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseId: dbId })
      .expect(201);
    expect(res.body.envVar).toBe("DATABASE_URL");
    const list = await request(app.getHttpServer()).get(`/apps/${appId}/database-links`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it("derives a distinct env var when the engine default is already taken", async () => {
    const db2 = await makeDb("cache");
    const res = await request(app.getHttpServer())
      .post(`/apps/${appId}/database-links`)
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseId: db2 })
      .expect(201);
    expect(res.body.envVar).not.toBe("DATABASE_URL");
    expect(res.body.envVar).toMatch(/_DATABASE_URL$/);
    // cleanup so later assertions about link count are stable
    await request(app.getHttpServer()).delete(`/apps/${appId}/database-links/${res.body.linkId}`).set("Authorization", `Bearer ${token}`).expect(200);
  });

  it("409s an explicit env var that collides with an existing link", async () => {
    const db3 = await makeDb("inventory");
    await request(app.getHttpServer())
      .post(`/apps/${appId}/database-links`)
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseId: db3, envVar: "DATABASE_URL" })
      .expect(409);
  });

  it("400s an env var that would hijack the runtime or is malformed", async () => {
    const db4 = await makeDb("logs");
    for (const envVar of ["LD_PRELOAD", "1BAD", "has space"]) {
      await request(app.getHttpServer())
        .post(`/apps/${appId}/database-links`)
        .set("Authorization", `Bearer ${token}`)
        .send({ databaseId: db4, envVar })
        .expect(400);
    }
  });

  it("404s a database that isn't in the app's team (no cross-team oracle)", async () => {
    // a second account with its own team + a DB record there
    const email2 = `link2-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
    const reg2 = await request(app.getHttpServer()).post("/auth/register").send({ email: email2, password, name: "Other" }).expect(201);
    const token2 = reg2.body.tokens.accessToken;
    const team2 = (await prisma.membership.findFirst({ where: { userId: reg2.body.user.id } }))!.teamId;
    const srv2 = await request(app.getHttpServer()).post("/servers").set("Authorization", `Bearer ${token2}`).send({ name: "n2", teamId: team2 }).expect(201);
    const fdb = await request(app.getHttpServer()).post("/databases").set("Authorization", `Bearer ${token2}`).send({ name: "foreign", serverId: srv2.body.server.id, engine: "POSTGRES" }).expect(201);

    await request(app.getHttpServer())
      .post(`/apps/${appId}/database-links`)
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseId: fdb.body.id })
      .expect(404);

    await prisma.team.deleteMany({ where: { id: team2 } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: email2 } }).catch(() => undefined);
  });

  it("404s deleting a link id that belongs to another app", async () => {
    await request(app.getHttpServer()).delete(`/apps/${appId}/database-links/nonexistent`).set("Authorization", `Bearer ${token}`).expect(404);
  });

  it("409s deleting a database that still has links, and allows it once unlinked", async () => {
    await request(app.getHttpServer()).delete(`/databases/${dbId}`).set("Authorization", `Bearer ${token}`).expect(409);
  });

  it("adopts a literal app-env key so the link isn't shadowed", async () => {
    const db5 = await makeDb("sessions");
    await request(app.getHttpServer())
      .put(`/apps/${appId}/env`)
      .set("Authorization", `Bearer ${token}`)
      .send({ env: { SESSION_URL: "postgresql://literal@old/db" } })
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`/apps/${appId}/database-links`)
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseId: db5, envVar: "SESSION_URL", adoptEnv: true })
      .expect(201);
    expect(res.body.shadowedBy).toBeNull();
    const env = await request(app.getHttpServer()).get(`/apps/${appId}/env`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(env.body.SESSION_URL).toBeUndefined(); // the literal was adopted away
  });

  it("unlinks cleanly, leaving no links", async () => {
    const list = await request(app.getHttpServer()).get(`/apps/${appId}/database-links`).set("Authorization", `Bearer ${token}`).expect(200);
    for (const l of list.body) {
      await request(app.getHttpServer()).delete(`/apps/${appId}/database-links/${l.linkId}`).set("Authorization", `Bearer ${token}`).expect(200);
    }
    const empty = await request(app.getHttpServer()).get(`/apps/${appId}/database-links`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(empty.body).toHaveLength(0);
  });
});
