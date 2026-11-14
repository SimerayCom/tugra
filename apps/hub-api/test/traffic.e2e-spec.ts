import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Traffic app scope (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `traffic-${stamp}@tugra.test`;
  const viewerEmail = `traffic-viewer-${stamp}@tugra.test`;
  const password = "supersecret123";
  let token = "";
  let teamId = "";
  let serverId = "";
  let shopId = "";
  let otherId = "";
  const host = (s: string) => `${s}-${stamp}.traffic-e2e.example.com`;
  const bearer = () => `Bearer ${token}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();

    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password, name: "Traffic" }).expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;
    const srv = await request(app.getHttpServer()).post("/servers").set("Authorization", bearer()).send({ name: "traffic-node", teamId }).expect(201);
    serverId = srv.body.server.id;

    // app "shop": a compose app with a primary domain, an alias and a per-service domain
    const shop = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", bearer())
      .send({ name: "shop", serverId, source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx:alpine\n  api:\n    image: nginx:alpine\n", domain: host("shop") })
      .expect(201);
    shopId = shop.body.id;
    await request(app.getHttpServer()).put(`/apps/${shopId}/extra-domains`).set("Authorization", bearer()).send({ domains: [host("alias")] }).expect(200);
    await request(app.getHttpServer())
      .put(`/apps/${shopId}/service-domains`)
      .set("Authorization", bearer())
      .send({ domains: [{ service: "api", hostname: host("api"), port: 80 }] })
      .expect(200);

    // a second app on the same server whose host must never leak into shop's scope
    const other = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", bearer())
      .send({ name: "other", serverId, image: "nginx:alpine", domain: host("other") })
      .expect(201);
    otherId = other.body.id;

    const bucket = new Date(Math.floor((Date.now() - 120_000) / 60_000) * 60_000);
    const row = (domain: string, appId: string | null, requests: number) => ({
      serverId, domain, appId, bucket, requests, s2xx: requests, s3xx: 0, s4xx: 0, s5xx: 0, bytes: BigInt(requests * 10),
    });
    await prisma.trafficMetric.createMany({
      data: [row(host("shop"), shopId, 10), row(host("alias"), shopId, 20), row(host("api"), shopId, 30), row(host("other"), otherId, 400)],
    });
    await prisma.trafficCountry.createMany({
      data: [
        { serverId, domain: host("shop"), bucket, country: "TR", requests: 10 },
        { serverId, domain: host("alias"), bucket, country: "DE", requests: 20 },
        { serverId, domain: host("other"), bucket, country: "US", requests: 400 },
      ],
    });
  });

  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { in: [email, viewerEmail] } } }).catch(() => undefined);
    await app.close();
  });

  it("team-wide traffic is unchanged (no appId): every host of the team's servers", async () => {
    const res = await request(app.getHttpServer()).get("/traffic/summary").query({ range: "1h", teamId }).set("Authorization", bearer()).expect(200);
    expect(res.body.totals.requests).toBe(460);
  });

  it("appId totals equal the app's primary + alias + service hosts and exclude another app's host", async () => {
    const res = await request(app.getHttpServer()).get("/traffic/summary").query({ range: "1h", appId: shopId }).set("Authorization", bearer()).expect(200);
    expect(res.body.totals.requests).toBe(60);
    const countries = await request(app.getHttpServer()).get("/traffic/countries").query({ range: "1h", appId: shopId }).set("Authorization", bearer()).expect(200);
    expect(countries.body.countries.map((c: { country: string }) => c.country).sort()).toEqual(["DE", "TR"]); // never the other app's US row
    const otherRes = await request(app.getHttpServer()).get("/traffic/summary").query({ range: "1h", appId: otherId }).set("Authorization", bearer()).expect(200);
    expect(otherRes.body.totals.requests).toBe(400);
  });

  it("domain narrows within the app; a host owned by another app returns nothing", async () => {
    const one = await request(app.getHttpServer()).get("/traffic/summary").query({ range: "1h", appId: shopId, domain: host("alias") }).set("Authorization", bearer()).expect(200);
    expect(one.body.totals.requests).toBe(20);
    const foreign = await request(app.getHttpServer()).get("/traffic/summary").query({ range: "1h", appId: shopId, domain: host("other") }).set("Authorization", bearer()).expect(200);
    expect(foreign.body.totals.requests).toBe(0);
  });

  it("another team's user gets an empty result for the appId, not the app's traffic", async () => {
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email: viewerEmail, password, name: "Outsider" }).expect(201);
    const res = await request(app.getHttpServer()).get("/traffic/summary").query({ range: "1h", appId: shopId }).set("Authorization", `Bearer ${reg.body.tokens.accessToken}`).expect(200);
    expect(res.body.totals.requests).toBe(0);
  });
});
