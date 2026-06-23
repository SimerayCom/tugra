import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Databases (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `db-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
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
      .send({ email, password, name: "DB" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "db-node", teamId })
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
  });

  afterAll(async () => {
    agent?.close();
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("creates a Postgres database, provisions it via the agent, and exposes connection info to the owner", async () => {
    const res = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "appdb", serverId, engine: "POSTGRES" })
      .expect(201);
    const dbId = res.body.id;
    expect(res.body.engine).toBe("POSTGRES");
    expect(res.body.status).toBe("NEW");
    expect(res.body.connectionUri).toContain("postgresql://");
    expect(res.body.password).toBeTruthy();

    commands.length = 0;
    const prov = await request(app.getHttpServer())
      .post(`/databases/${dbId}/provision`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(prov.body.status).toBe("RUNNING");
    await sleep(100);

    const sent = commands.join("\n");
    expect(sent).toContain("docker run");
    expect(sent).toContain("--network tugra-net");
    expect(sent).toContain("-v tugra_dbv_");
    expect(sent).toContain("postgres:16");

    const detail = await request(app.getHttpServer())
      .get(`/databases/${dbId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.status).toBe("RUNNING");
  });

  it("sets and normalizes tags on a database", async () => {
    const res = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "tagdb", serverId, engine: "POSTGRES" })
      .expect(201);
    const dbId = res.body.id;
    expect(res.body.tags).toEqual([]);

    await request(app.getHttpServer())
      .put(`/databases/${dbId}/tags`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tags: ["Cache", "prod", "cache"] })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/databases/${dbId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.tags).toEqual(["cache", "prod"]);
  });

  it("applies resource limits + health-check at provision", async () => {
    const res = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "limdb", serverId, engine: "POSTGRES" })
      .expect(201);
    const dbId = res.body.id;

    await request(app.getHttpServer())
      .put(`/databases/${dbId}/limits`)
      .set("Authorization", `Bearer ${token}`)
      .send({ memoryMb: 512, cpus: 0.5, healthCmd: "pg_isready -U tugra || exit 1" })
      .expect(200);

    commands.length = 0;
    await request(app.getHttpServer())
      .post(`/databases/${dbId}/provision`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(100);
    const sent = commands.join("\n");
    expect(sent).toContain("--memory 512m");
    expect(sent).toContain("--cpus 0.5");
    expect(sent).toContain("--health-cmd 'pg_isready -U tugra || exit 1'");
  });

  it("exposes and removes the public host port across re-provisions", async () => {
    const res = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "portdb", serverId, engine: "POSTGRES" })
      .expect(201);
    const dbId = res.body.id;

    await request(app.getHttpServer())
      .put(`/databases/${dbId}/port`)
      .set("Authorization", `Bearer ${token}`)
      .send({ hostPort: 15432 })
      .expect(200);
    const detail = await request(app.getHttpServer())
      .get(`/databases/${dbId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.hostPort).toBe(15432);

    commands.length = 0;
    await request(app.getHttpServer()).post(`/databases/${dbId}/provision`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(100);
    expect(commands.join("\n")).toContain("-p 15432:");

    // remove public access → no -p flag on next provision
    await request(app.getHttpServer())
      .put(`/databases/${dbId}/port`)
      .set("Authorization", `Bearer ${token}`)
      .send({ hostPort: null })
      .expect(200);
    commands.length = 0;
    await request(app.getHttpServer()).post(`/databases/${dbId}/provision`).set("Authorization", `Bearer ${token}`).expect(200);
    await sleep(100);
    expect(commands.join("\n")).not.toContain("-p 15432:");
  });

  it("rejects creating a database on a server the user has no access to", async () => {
    await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x", serverId: "nonexistent-server", engine: "REDIS" })
      .expect(404);
  });

  it("provisions a MariaDB database (new engine)", async () => {
    const res = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "mariadb1", serverId, engine: "MARIADB" })
      .expect(201);
    expect(res.body.engine).toBe("MARIADB");
    expect(res.body.backupSupported).toBe(true);
    expect(res.body.connectionUri).toContain("mysql://");

    commands.length = 0;
    await request(app.getHttpServer())
      .post(`/databases/${res.body.id}/provision`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await sleep(80);
    expect(commands.join("\n")).toContain("mariadb:11");
  });

  it("creates a ClickHouse database but refuses backup (provision-only)", async () => {
    const res = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "ch1", serverId, engine: "CLICKHOUSE" })
      .expect(201);
    expect(res.body.engine).toBe("CLICKHOUSE");
    expect(res.body.backupSupported).toBe(false);

    await request(app.getHttpServer())
      .post(`/databases/${res.body.id}/backups`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });
});
