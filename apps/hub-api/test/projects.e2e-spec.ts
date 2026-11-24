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

  it("starts a registered team with no project (and never a \"Default\" one)", async () => {
    const res = await request(app.getHttpServer())
      .get("/projects")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const mine = res.body.filter((p: { teamId: string }) => p.teamId === teamId);
    expect(mine.some((p: { name: string }) => p.name === "Default")).toBe(false);
    expect(mine.filter((p: { isDefault: boolean }) => p.isDefault)).toHaveLength(0);
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
    const withStaging = await request(app.getHttpServer())
      .post(`/projects/${projectId}/environments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "staging" })
      .expect(201);
    const stagingEnv = withStaging.body.environments.find(
      (e: { id: string; name: string }) => e.name === "staging",
    ).id;

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

    // an app always belongs to an environment: un-assigning (null) is rejected
    await request(app.getHttpServer())
      .put(`/apps/${appRes.body.id}/environment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ environmentId: null })
      .expect(400);

    // move the app to another env, then deleting the now-empty production env succeeds
    await request(app.getHttpServer())
      .put(`/apps/${appRes.body.id}/environment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ environmentId: stagingEnv })
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
  describe("empty Default cleanup and moving a project to another team", () => {
    const auth = () => ({ Authorization: `Bearer ${token}` });
    const extraTeams: string[] = [];
    const extraEmails: string[] = [];
    const legacyDefault = async (name = "Default") =>
      prisma.project.create({
        data: { teamId, name, environments: { create: { name: "production" } } },
        include: { environments: true },
      });
    afterAll(async () => {
      await prisma.team.deleteMany({ where: { id: { in: extraTeams } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { email: { in: extraEmails } } }).catch(() => undefined);
    });

    it("lists empty Default projects only to the team owner and removes only the truly empty ones", async () => {
      const empty = await legacyDefault();
      const used = await legacyDefault();
      await request(app.getHttpServer())
        .post("/apps")
        .set(auth())
        .send({ name: "in-default", serverId, image: "nginx:alpine", environmentId: used.environments[0].id })
        .expect(201);

      // an ADMIN of the same team is not an owner: nothing is offered
      const adminEmail = `proj-admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
      extraEmails.push(adminEmail);
      const reg = await request(app.getHttpServer()).post("/auth/register").send({ email: adminEmail, password, name: "Adm" }).expect(201);
      await prisma.membership.create({ data: { teamId, userId: reg.body.user.id, role: "ADMIN" } });
      const asAdmin = await request(app.getHttpServer())
        .get("/projects/empty-defaults")
        .set("Authorization", `Bearer ${reg.body.tokens.accessToken}`)
        .expect(200);
      expect(asAdmin.body).toEqual([]);

      const offered = await request(app.getHttpServer()).get("/projects/empty-defaults").set(auth()).expect(200);
      const ids = offered.body.map((p: { id: string }) => p.id);
      expect(ids).toContain(empty.id);
      expect(ids).not.toContain(used.id);

      // the admin cannot remove either (owner-only), the owner can; a project with resources is skipped, not deleted
      const denied = await request(app.getHttpServer())
        .post("/projects/empty-defaults/remove")
        .set("Authorization", `Bearer ${reg.body.tokens.accessToken}`)
        .send({ ids: [empty.id] })
        .expect(200);
      expect(denied.body).toEqual({ removed: [], skipped: [empty.id] });

      const res = await request(app.getHttpServer())
        .post("/projects/empty-defaults/remove")
        .set(auth())
        .send({ ids: [empty.id, used.id] })
        .expect(200);
      expect(res.body).toEqual({ removed: [empty.id], skipped: [used.id] });
      expect(await prisma.project.findUnique({ where: { id: empty.id } })).toBeNull();
      expect(await prisma.project.findUnique({ where: { id: used.id } })).not.toBeNull();
    });

    it("moves an empty project to another team the caller manages, refuses one with resources (409) and a team the caller is not in (403)", async () => {
      const second = await prisma.team.create({ data: { name: "second" } });
      extraTeams.push(second.id);
      const meId = (await prisma.membership.findFirst({ where: { teamId } }))!.userId;
      await prisma.membership.create({ data: { teamId: second.id, userId: meId, role: "OWNER" } });
      const stranger = await prisma.team.create({ data: { name: "stranger" } });
      extraTeams.push(stranger.id);

      const empty = await request(app.getHttpServer()).post("/projects").set(auth()).send({ teamId, name: "movable" }).expect(201);
      const full = await request(app.getHttpServer()).post("/projects").set(auth()).send({ teamId, name: "pinned" }).expect(201);
      await request(app.getHttpServer())
        .post("/apps")
        .set(auth())
        .send({ name: "pinned-app", serverId, image: "nginx:alpine", environmentId: full.body.environments[0].id })
        .expect(201);

      await request(app.getHttpServer()).put(`/projects/${full.body.id}/team`).set(auth()).send({ teamId: second.id }).expect(409);
      await request(app.getHttpServer()).put(`/projects/${empty.body.id}/team`).set(auth()).send({ teamId: stranger.id }).expect(403);
      expect((await prisma.project.findUnique({ where: { id: empty.body.id } }))!.teamId).toBe(teamId);

      const moved = await request(app.getHttpServer()).put(`/projects/${empty.body.id}/team`).set(auth()).send({ teamId: second.id }).expect(200);
      expect(moved.body.teamId).toBe(second.id);
      expect((await prisma.project.findUnique({ where: { id: full.body.id } }))!.teamId).toBe(teamId);
    });
  });
});
