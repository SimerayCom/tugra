import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { InFlightService } from "../src/in-flight/in-flight.service";
import { PrismaService } from "../src/prisma/prisma.service";

// Runs every in-flight query against the real schema: the unit specs mock Prisma, and a query the database rejects would
// hold every update (the read fails closed). A server with one running deployment shows up hub-wide and for that server.
describe("in-flight read (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: InFlightService;
  const tag = `inflight-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let teamId = "";
  let serverId = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    svc = app.get(InFlightService);
  });

  afterAll(async () => {
    if (teamId) await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await app.close();
  });

  it("every source query runs against the database", async () => {
    await expect(svc.list()).resolves.toEqual(expect.any(Array));
    await expect(svc.listForServers(["nope"])).resolves.toEqual(expect.any(Array));
  });

  it("a running deployment is in flight, hub-wide and for its server only", async () => {
    const team = await prisma.team.create({ data: { name: tag } });
    teamId = team.id;
    const server = await prisma.server.create({ data: { name: `${tag}-srv`, teamId, enrollToken: tag } });
    serverId = server.id;
    const project = await prisma.project.create({ data: { name: `${tag}-p`, teamId } });
    const env = await prisma.environment.create({ data: { name: "production", projectId: project.id } });
    const appRow = await prisma.application.create({ data: { name: `${tag}-app`, teamId, serverId, environmentId: env.id, env: [], volumes: [] } });
    await prisma.deployment.create({ data: { appId: appRow.id, status: "RUNNING" } });

    const all = await svc.list();
    expect(all.some((i) => i.kind === "deployment" && i.serverIds.includes(serverId))).toBe(true);
    const mine = await svc.listForServers([serverId]);
    expect(mine.some((i) => i.kind === "deployment")).toBe(true);
    const other = await svc.listForServers(["not-a-server"]);
    expect(other.some((i) => i.serverIds.includes(serverId))).toBe(false);
  });
});
