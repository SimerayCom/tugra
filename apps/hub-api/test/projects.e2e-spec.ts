import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Projects / Environments (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `proj-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let serverId = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    void (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "Proj" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;

    const srv = await request(app.getHttpServer())
      .post("/servers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "proj-node", teamId })
      .expect(201);
    serverId = srv.body.server.id;
  });

  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("bootstraps a registered team with exactly one default project + production env", async () => {
    const res = await request(app.getHttpServer())
      .get("/projects")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const mine = res.body.filter((p: { teamId: string }) => p.teamId === teamId);
    const defaults = mine.filter((p: { isDefault: boolean }) => p.isDefault);
    expect(defaults).toHaveLength(1);
    const def = defaults[0];
    expect(def.name).toBe("Default");
    const defEnvs = def.environments.filter((e: { isDefault: boolean }) => e.isDefault);
    expect(defEnvs).toHaveLength(1);
    expect(defEnvs[0].name).toBe("production");
  });

  it("creates a project with a default production environment and groups a resource", async () => {
    const proj = await request(app.getHttpServer())
      .post("/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ teamId, name: "web-platform" })
      .expect(201);
    expect(proj.body.environments).toHaveLength(1);
    expect(proj.body.environments[0].name).toBe("production");
    const prodEnv = proj.body.environments[0].id;
    const projectId = proj.body.id;

    // add a second environment
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/environments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "staging" })
      .expect(201);

    // create an app directly in the production environment
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "site", serverId, image: "nginx:alpine", environmentId: prodEnv })
      .expect(201);
    expect(appRes.body.environmentId).toBe(prodEnv);

    // project detail shows the app under production
    const detail = await request(app.getHttpServer())
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const prod = detail.body.environments.find((e: { id: string }) => e.id === prodEnv);
    expect(prod.resources.some((r: { name: string; kind: string }) => r.name === "site" && r.kind === "app")).toBe(true);

    // deleting the environment with a resource is refused
    await request(app.getHttpServer())
      .delete(`/projects/environments/${prodEnv}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(409);

    // move the app out, then deletion succeeds
    await request(app.getHttpServer())
      .put(`/apps/${appRes.body.id}/environment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ environmentId: null })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/projects/environments/${prodEnv}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  });

  it("rejects assigning an app to an environment in another team", async () => {
    // a project/env owned by a different team the user is not in
    const otherTeam = await prisma.team.create({ data: { name: "other" } });
    const otherProj = await prisma.project.create({
      data: { teamId: otherTeam.id, name: "x", environments: { create: { name: "production" } } },
      include: { environments: true },
    });
    const appRes = await request(app.getHttpServer())
      .post("/apps")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "site2", serverId, image: "nginx:alpine" })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/apps/${appRes.body.id}/environment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ environmentId: otherProj.environments[0].id })
      .expect(400);
    await prisma.team.delete({ where: { id: otherTeam.id } }).catch(() => undefined);
  });
});
