import { CanActivate, ExecutionContext, ForbiddenException, INestApplication, Injectable } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { configureApp } from "../app-config";
import { ApiExceptionFilter } from "../common/api-exception.filter";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { InstanceOwnerGuard } from "../instance/instance-owner.guard";
import { PanelDomainController } from "./panel-domain.controller";
import { PanelDomainService } from "./panel-domain.service";

/** Stands in for the session guard: the caller arrives in a header. */
@Injectable()
class FakeJwt implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = { userId: String(req.headers["x-test-user"] ?? "owner-1") };
    return true;
  }
}
/** Stands in for the owner check (the real one needs Prisma): only user "owner-1" is the instance owner. */
@Injectable()
class FakeOwner implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.switchToHttp().getRequest().user?.userId !== "owner-1") throw new ForbiddenException();
    return true;
  }
}

const STATUS = { mode: "ip", domain: null, url: "http://203.0.113.9", ipRoute: true, localServerOnline: true, acmeEmail: null, job: { phase: "idle", action: null, domain: null, error: null, code: null, detail: null, startedAt: null } };

describe("PanelDomainController (HTTP level)", () => {
  let app: INestApplication;
  const svc = { status: jest.fn(), set: jest.fn(), remove: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [PanelDomainController],
      providers: [
        { provide: PanelDomainService, useValue: svc },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(FakeJwt)
      .overrideGuard(InstanceOwnerGuard)
      .useClass(FakeOwner)
      .compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    svc.status.mockResolvedValue(STATUS);
    svc.set.mockResolvedValue(STATUS);
    svc.remove.mockResolvedValue(STATUS);
  });
  const srv = () => app.getHttpServer();

  it("is guarded by the session AND the instance-owner guard (a PAT can't reach it, a non-owner can't either)", () => {
    const guards = Reflect.getMetadata("__guards__", PanelDomainController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, InstanceOwnerGuard]));
  });

  it("GET returns the status, never cached", async () => {
    const res = await request(srv()).get("/api/v1/instance/panel-domain").expect(200);
    expect(res.body.mode).toBe("ip");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("POST sets the domain: 202, validated body, the acting owner is passed through", async () => {
    await request(srv()).post("/api/v1/instance/panel-domain").send({ domain: " Panel.Example.com ", acmeEmail: "ops@real-domain.io" }).expect(202);
    expect(svc.set).toHaveBeenCalledWith("owner-1", { domain: "Panel.Example.com", acmeEmail: "ops@real-domain.io" });
  });

  it("POST rejects a missing / oversized domain before the service runs", async () => {
    await request(srv()).post("/api/v1/instance/panel-domain").send({}).expect(400);
    await request(srv()).post("/api/v1/instance/panel-domain").send({ domain: "a".repeat(300) }).expect(400);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it("POST remove: 202, optional publicIp must be a bare IPv4", async () => {
    await request(srv()).post("/api/v1/instance/panel-domain/remove").send({}).expect(202);
    expect(svc.remove).toHaveBeenCalledWith("owner-1", {});
    await request(srv()).post("/api/v1/instance/panel-domain/remove").send({ publicIp: "198.51.100.4" }).expect(202);
    await request(srv()).post("/api/v1/instance/panel-domain/remove").send({ publicIp: "not-an-ip" }).expect(400);
    expect(svc.remove).toHaveBeenCalledTimes(2);
  });

  it("a non-owner is refused on every route", async () => {
    await request(srv()).get("/api/v1/instance/panel-domain").set("x-test-user", "member-9").expect(403);
    await request(srv()).post("/api/v1/instance/panel-domain").set("x-test-user", "member-9").send({ domain: "panel.example.com" }).expect(403);
    await request(srv()).post("/api/v1/instance/panel-domain/remove").set("x-test-user", "member-9").send({}).expect(403);
    expect(svc.set).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
  });
});
