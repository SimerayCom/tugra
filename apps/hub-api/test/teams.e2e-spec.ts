import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { MailService } from "../src/mail/mail.service";

describe("Teams (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const emailA = `team-a-${stamp}@tugra.test`;
  const emailB = `team-b-${stamp}@tugra.test`;
  const password = "supersecret123";
  let tokenA = "";
  let tokenB = "";
  let userBId = "";
  let teamId = "";
  // Capture "sent" invite emails to assert the accept link is delivered.
  const sentInvites: { to: string; html: string }[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({
        isConfigured: () => true,
        send: async (to: string, e: { html: string }) => {
          sentInvites.push({ to, html: e.html });
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    void (app.getHttpServer().address() as AddressInfo).port;

    const a = await request(app.getHttpServer()).post("/auth/register").send({ email: emailA, password, name: "A" }).expect(201);
    tokenA = a.body.tokens.accessToken;
    const b = await request(app.getHttpServer()).post("/auth/register").send({ email: emailB, password, name: "B" }).expect(201);
    tokenB = b.body.tokens.accessToken;
    userBId = b.body.user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } }).catch(() => undefined);
    await app.close();
  });

  it("creates a team, invites a user, who accepts and is managed", async () => {
    const created = await request(app.getHttpServer())
      .post("/teams")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "Platform" })
      .expect(201);
    teamId = created.body.id;
    expect(created.body.role).toBe("OWNER");

    // invite B
    const inv = await request(app.getHttpServer())
      .post(`/teams/${teamId}/members/invite`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: emailB, role: "VIEWER" })
      .expect(201);
    expect(inv.body.token).toBeTruthy();
    // The invitation was ALSO emailed to B, carrying the accept link with the token.
    const emailed = sentInvites.filter((e) => e.to === emailB);
    expect(emailed.length).toBeGreaterThanOrEqual(1);
    expect(emailed[emailed.length - 1].html).toContain(`/invite/${inv.body.token}`);

    // B sees it
    const mine = await request(app.getHttpServer())
      .get("/teams/invitations/mine")
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200);
    expect(mine.body.some((i: { token: string }) => i.token === inv.body.token)).toBe(true);

    // B accepts
    await request(app.getHttpServer())
      .post(`/teams/invitations/${inv.body.token}/accept`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200);

    // members now 2
    const members = await request(app.getHttpServer())
      .get(`/teams/${teamId}/members`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
    expect(members.body).toHaveLength(2);

    // promote B to ADMIN, then remove
    await request(app.getHttpServer())
      .put(`/teams/${teamId}/members/${userBId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ role: "ADMIN" })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/teams/${teamId}/members/${userBId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
  });

  it("returns a single team via GET /teams/:id (with memberCount)", async () => {
    const res = await request(app.getHttpServer())
      .get(`/teams/${teamId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
    expect(res.body.id).toBe(teamId);
    expect(res.body.role).toBe("OWNER");
    expect(res.body.memberCount).toBeGreaterThanOrEqual(1);
  });

  it("404s an unknown team and forbids a non-member", async () => {
    await request(app.getHttpServer())
      .get(`/teams/does-not-exist`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/teams/${teamId}`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(403); // B was removed above
  });

  it("rejects accepting an invitation meant for another account", async () => {
    const inv = await request(app.getHttpServer())
      .post(`/teams/${teamId}/members/invite`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: `nobody-${stamp}@tugra.test`, role: "VIEWER" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/teams/invitations/${inv.body.token}/accept`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(403);
  });

  it("previews an invitation publicly (no auth) by its token", async () => {
    const previewEmail = `preview-${stamp}@tugra.test`;
    const inv = await request(app.getHttpServer())
      .post(`/teams/${teamId}/members/invite`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: previewEmail, role: "ADMIN" })
      .expect(201);

    // No Authorization header — the preview is public.
    const res = await request(app.getHttpServer()).get(`/invitations/${inv.body.token}`).expect(200);
    expect(res.body.teamName).toBeTruthy();
    expect(res.body.role).toBe("ADMIN");
    expect(res.body.email).toBe(previewEmail);
    expect(res.body.expired).toBe(false);
    expect("inviterName" in res.body).toBe(true);

    // Unknown token → 404.
    await request(app.getHttpServer()).get("/invitations/nope-not-a-token").expect(404);
  });

  it("deletes an empty team", async () => {
    await request(app.getHttpServer())
      .delete(`/teams/${teamId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
  });

  it("restricts a VIEWER to specific projects (per-resource RBAC scoping, end-to-end)", async () => {
    const bearerA = `Bearer ${tokenA}`;
    const bearerB = `Bearer ${tokenB}`;
    // Fresh team so earlier tests (which removed B) don't interfere; re-invite B as VIEWER.
    const team = await request(app.getHttpServer()).post("/teams").set("Authorization", bearerA).send({ name: "Scoped" }).expect(201);
    const tid = team.body.id;
    const inv = await request(app.getHttpServer()).post(`/teams/${tid}/members/invite`).set("Authorization", bearerA).send({ email: emailB, role: "VIEWER" }).expect(201);
    await request(app.getHttpServer()).post(`/teams/invitations/${inv.body.token}/accept`).set("Authorization", bearerB).expect(200);

    const p1 = await request(app.getHttpServer()).post("/projects").set("Authorization", bearerA).send({ teamId: tid, name: "visible" }).expect(201);
    const p2 = await request(app.getHttpServer()).post("/projects").set("Authorization", bearerA).send({ teamId: tid, name: "secret" }).expect(201);
    const inThisTeam = (body: { teamId: string; id: string }[]) => body.filter((p) => p.teamId === tid).map((p) => p.id);

    // Unrestricted VIEWER sees every project in the team (the team's default project + p1 + p2).
    const before = await request(app.getHttpServer()).get("/projects").set("Authorization", bearerB).expect(200);
    expect(inThisTeam(before.body)).toEqual(expect.arrayContaining([p1.body.id, p2.body.id]));

    // Restrict B to only p1.
    await request(app.getHttpServer())
      .patch(`/teams/${tid}/members/${userBId}/access`)
      .set("Authorization", bearerA)
      .send({ restrictedAccess: true, accessedProjects: [p1.body.id] })
      .expect(200);

    // Now the list is filtered and the ungranted project is 403 (get is scoped too).
    const after = await request(app.getHttpServer()).get("/projects").set("Authorization", bearerB).expect(200);
    expect(inThisTeam(after.body)).toEqual([p1.body.id]);
    await request(app.getHttpServer()).get(`/projects/${p1.body.id}`).set("Authorization", bearerB).expect(200);
    await request(app.getHttpServer()).get(`/projects/${p2.body.id}`).set("Authorization", bearerB).expect(403);

    // A VIEWER can't change scoping (manager-only).
    await request(app.getHttpServer())
      .patch(`/teams/${tid}/members/${userBId}/access`)
      .set("Authorization", bearerB)
      .send({ restrictedAccess: false, accessedProjects: [] })
      .expect(403);

    await prisma.team.deleteMany({ where: { id: tid } }).catch(() => undefined);
  });

  it("grants a member exactly a custom role's permissions (granular RBAC, end-to-end)", async () => {
    const bearerA = `Bearer ${tokenA}`;
    const bearerB = `Bearer ${tokenB}`;
    const team = await request(app.getHttpServer()).post("/teams").set("Authorization", bearerA).send({ name: "Roles" }).expect(201);
    const tid = team.body.id;
    const inv = await request(app.getHttpServer()).post(`/teams/${tid}/members/invite`).set("Authorization", bearerA).send({ email: emailB, role: "VIEWER" }).expect(201);
    await request(app.getHttpServer()).post(`/teams/invitations/${inv.body.token}/accept`).set("Authorization", bearerB).expect(200);

    // Baseline: a plain VIEWER can write nothing.
    await request(app.getHttpServer()).post("/projects").set("Authorization", bearerB).send({ teamId: tid, name: "nope" }).expect(403);

    // Owner defines a custom role that grants ONLY "projects", and assigns it to B.
    const role = await request(app.getHttpServer())
      .post(`/teams/${tid}/roles`)
      .set("Authorization", bearerA)
      .send({ name: "Project Manager", permissions: ["projects", "not-a-real-permission"] })
      .expect(201);
    expect(role.body.permissions).toEqual(["projects"]); // invalid permission filtered out
    await request(app.getHttpServer()).put(`/teams/${tid}/members/${userBId}`).set("Authorization", bearerA).send({ teamRoleId: role.body.id }).expect(200);

    // The member row now shows the custom role name.
    const members = await request(app.getHttpServer()).get(`/teams/${tid}/members`).set("Authorization", bearerA).expect(200);
    expect(members.body.find((m: { userId: string }) => m.userId === userBId).roleName).toBe("Project Manager");

    // Project scoping doesn't apply to a custom-role member (it wouldn't gate their writes) → refused,
    // so an admin can't set an unenforceable restriction that gives a false sense of confinement.
    await request(app.getHttpServer())
      .patch(`/teams/${tid}/members/${userBId}/access`)
      .set("Authorization", bearerA)
      .send({ restrictedAccess: true, accessedProjects: [] })
      .expect(409);

    // B can now create a project (has "projects")…
    await request(app.getHttpServer()).post("/projects").set("Authorization", bearerB).send({ teamId: tid, name: "allowed" }).expect(201);
    // …but still can't create a server (lacks "servers:manage").
    await request(app.getHttpServer()).post("/servers").set("Authorization", bearerB).send({ name: "srv", teamId: tid }).expect(403);
    // …and can't manage the role catalog (that stays built-in-admin only — no self-escalation).
    await request(app.getHttpServer()).post(`/teams/${tid}/roles`).set("Authorization", bearerB).send({ name: "Hacker", permissions: ["servers:manage"] }).expect(403);

    // Deleting the role reverts B to their enum tier (VIEWER) → project creation is forbidden again.
    await request(app.getHttpServer()).delete(`/teams/${tid}/roles/${role.body.id}`).set("Authorization", bearerA).expect(200);
    await request(app.getHttpServer()).post("/projects").set("Authorization", bearerB).send({ teamId: tid, name: "nope2" }).expect(403);

    await prisma.team.deleteMany({ where: { id: tid } }).catch(() => undefined);
  });
});
