import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Backup destinations + offsite (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `dest-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let agent: WebSocket;
  let serverId = "";
  let dbId = "";
  let destId = "";
  const commands: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "DEST" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const created = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "dest-node", teamId })
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
          // S3 backup ends with `mc stat --json` → return a size in JSON
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode: 0, output: '{"status":"success","size":40960}' }));
        }
      });
    });

    const dbRes = await request(app.getHttpServer())
      .post("/databases")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "appdb", serverId, engine: "POSTGRES" })
      .expect(201);
    dbId = dbRes.body.id;
  });

  afterAll(async () => {
    agent?.close();
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("creates an encrypted S3 destination and never returns the secret", async () => {
    const res = await request(app.getHttpServer())
      .post("/backup-destinations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        teamId,
        name: "prod-s3",
        type: "S3",
        s3Bucket: "my-bucket",
        s3Region: "us-east-1",
        s3Endpoint: "s3.amazonaws.com",
        s3AccessKey: "AKIAEXAMPLE",
        s3SecretKey: "topsecret",
        s3Prefix: "tugra",
        encryptionEnabled: true,
      })
      .expect(201);
    destId = res.body.id;
    expect(res.body.encryptionEnabled).toBe(true);
    expect(res.body.hasCredentials).toBe(true);
    expect(res.body).not.toHaveProperty("s3SecretKey");
    // stored encrypted, not plaintext
    const row = await prisma.backupDestination.findUnique({ where: { id: destId } });
    expect(row?.s3SecretKey).not.toBe("topsecret");
  });

  it("validates S3 destinations require bucket + creds", async () => {
    await request(app.getHttpServer())
      .post("/backup-destinations")
      .set("Authorization", `Bearer ${token}`)
      .send({ teamId, name: "bad", type: "S3" })
      .expect(400);
  });

  it("backs up to S3 via mc pipe when the database points at the destination", async () => {
    await request(app.getHttpServer())
      .put(`/databases/${dbId}/backup-config`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: false, destinationId: destId })
      .expect(200);

    commands.length = 0;
    const res = await request(app.getHttpServer())
      .post(`/databases/${dbId}/backups`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    expect(res.body.status).toBe("SUCCESS");
    expect(res.body.sizeBytes).toBe("40960"); // parsed from mc stat --json
    await sleep(50);

    const sent = commands.join("\n");
    expect(sent).toContain("mc pipe tdest/my-bucket/tugra/");
    expect(sent).toContain("MC_HOST_tdest=");
    expect(sent).toContain("gpg"); // destination has encryption enabled
    expect(sent).toContain("pg_dump");
  });

  it("lists destinations for the team", async () => {
    const list = await request(app.getHttpServer())
      .get("/backup-destinations")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.some((d: { id: string }) => d.id === destId)).toBe(true);
  });
});
