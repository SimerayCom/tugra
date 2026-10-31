import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { VaultApiClient } from "../src/secret-providers/vault-api.client";

describe("Secret providers (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `secret-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let serverId = "";
  let appId = "";
  let providerId = "";
  const SECRET_TOKEN = "hvs.SUPER_SECRET_VAULT_TOKEN";
  // Configuring a provider / binding a secret is Pro-gated (RequireEditionGuard). Run this suite as the Pro
  // edition so the gated routes are exercised; restore the env afterwards so other suites are unaffected.
  const ORIGINAL_EDITION = process.env.TUGRA_EDITION;

  beforeAll(async () => {
    process.env.TUGRA_EDITION = "pro";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Stub the Vault client so create/test never make a real network call; fetchSecret is unused here
      // (deploy-time resolution is unit-tested) but provided for completeness.
      .overrideProvider(VaultApiClient)
      .useValue({
        verify: async () => ({ valid: true }),
        fetchSecret: async () => "stub-value",
      })
      .compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();

    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password, name: "Sec" }).expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const srv = await request(app.getHttpServer()).post("/servers").set("Authorization", `Bearer ${token}`).send({ name: "sec-node", teamId }).expect(201);
    serverId = srv.body.server.id;

    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "secapp", serverId, image: "nginx:alpine", hostPort: 8097 })
      .expect(201);
    appId = appRes.body.id;
  });

  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
    if (ORIGINAL_EDITION === undefined) delete process.env.TUGRA_EDITION;
    else process.env.TUGRA_EDITION = ORIGINAL_EDITION;
  });

  it("creates a Vault provider (token verified then never returned)", async () => {
    const res = await request(app.getHttpServer())
      .post("/secret-providers")
      .set("Authorization", `Bearer ${token}`)
      .send({ teamId, name: "prod-vault", kind: "vault", address: "https://vault.example.com", token: SECRET_TOKEN })
      .expect(201);
    providerId = res.body.id;
    expect(res.body).toMatchObject({ name: "prod-vault", kind: "vault", address: "https://vault.example.com", refCount: 0, canWrite: true });
    expect(res.body.lastVerifiedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain("tokenEnc");
  });

  it("rejects an unsupported kind at the DTO (400)", async () => {
    await request(app.getHttpServer())
      .post("/secret-providers")
      .set("Authorization", `Bearer ${token}`)
      .send({ teamId, name: "x", kind: "infisical", address: "https://x.example.com", token: "t" })
      .expect(400);
  });

  it("rejects a non-http address at the DTO (400)", async () => {
    await request(app.getHttpServer())
      .post("/secret-providers")
      .set("Authorization", `Bearer ${token}`)
      .send({ teamId, name: "x", kind: "vault", address: "ftp://nope", token: "t" })
      .expect(400);
  });

  it("lists providers without ever returning the token", async () => {
    const res = await request(app.getHttpServer()).get("/secret-providers").set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain("tokenEnc");
  });

  it("tests and renames the provider", async () => {
    await request(app.getHttpServer()).post(`/secret-providers/${providerId}/test`).set("Authorization", `Bearer ${token}`).expect(200);
    const res = await request(app.getHttpServer()).put(`/secret-providers/${providerId}`).set("Authorization", `Bearer ${token}`).send({ name: "prod-vault-2" }).expect(200);
    expect(res.body.name).toBe("prod-vault-2");
  });

  it("binds a secret to the app (no value in the response) and lists it", async () => {
    const bind = await request(app.getHttpServer())
      .post(`/apps/${appId}/secret-refs`)
      .set("Authorization", `Bearer ${token}`)
      .send({ providerId, envVar: "DB_PASSWORD", remoteKey: "secret/myapp#DB_PASSWORD" })
      .expect(201);
    expect(bind.body).toMatchObject({ envVar: "DB_PASSWORD", providerId, providerName: "prod-vault-2", kind: "vault" });
    expect(JSON.stringify(bind.body)).not.toContain("stub-value");

    const list = await request(app.getHttpServer()).get(`/apps/${appId}/secret-refs`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ envVar: "DB_PASSWORD", remoteKey: "secret/myapp#DB_PASSWORD", overridesAppEnv: false });
  });

  it("rejects a malformed Vault locator (400) and a duplicate env var (409)", async () => {
    await request(app.getHttpServer())
      .post(`/apps/${appId}/secret-refs`)
      .set("Authorization", `Bearer ${token}`)
      .send({ providerId, envVar: "OTHER", remoteKey: "no-hash" })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/apps/${appId}/secret-refs`)
      .set("Authorization", `Bearer ${token}`)
      .send({ providerId, envVar: "DB_PASSWORD", remoteKey: "secret/myapp#OTHER" })
      .expect(409);
  });

  it("refuses to delete a provider that still has refs (409), then succeeds once unbound", async () => {
    await request(app.getHttpServer()).delete(`/secret-providers/${providerId}`).set("Authorization", `Bearer ${token}`).expect(409);

    const list = await request(app.getHttpServer()).get(`/apps/${appId}/secret-refs`).set("Authorization", `Bearer ${token}`).expect(200);
    const refId = list.body[0].refId;
    await request(app.getHttpServer()).delete(`/apps/${appId}/secret-refs/${refId}`).set("Authorization", `Bearer ${token}`).expect(200);

    await request(app.getHttpServer()).delete(`/secret-providers/${providerId}`).set("Authorization", `Bearer ${token}`).expect(200);
  });
});
