import { ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ServerScanService } from "./server-scan.service";
import { buildDockerScanScript, buildHostScanScript } from "./server-scan";
import { AgentCommandTimeoutException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import { ServerOpsController } from "./server-ops.controller";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";

const NOW = new Date("2026-11-24T12:00:00Z");
const DOCKER_OUT = `TUGRA_SCAN_DOCKER_BEGIN
${JSON.stringify(["/cache", "redis:7", "running", "", "", "", "", "", "6379"])}
TUGRA_SCAN_DOCKER_END
`;
const HOST_OUT = `TUGRA_SCAN_HOST_BEGIN
${JSON.stringify({ v: 1, markers: ["nginx"], pm2: [], sites: [], services: [], ports: [], errors: [] })}
TUGRA_SCAN_HOST_END
`;

function setup(over: { server?: Record<string, unknown> | null; send?: jest.Mock; perm?: jest.Mock; role?: string | null } = {}) {
  const server = over.server === undefined ? { id: "s1", teamId: "t1", scanReport: null, scannedAt: null } : over.server;
  const update = jest.fn().mockResolvedValue({});
  const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server), update } } as unknown as PrismaService;
  const access = {
    teamRole: jest.fn().mockResolvedValue(over.role === undefined ? "ADMIN" : over.role),
    requirePermission: over.perm ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as TeamAccessService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const sendCommand =
    over.send ??
    jest.fn().mockImplementation(async (_id: string, script: string) => ({ exitCode: 0, output: script === buildDockerScanScript() ? DOCKER_OUT : HOST_OUT }));
  const agentWs = { sendCommand } as unknown as AgentWsServer;
  return { svc: new ServerScanService(prisma, access, audit, agentWs), update, sendCommand, audit, access };
}

describe("ServerScanService.getView", () => {
  it("never talks to the agent; null when never scanned", async () => {
    const { svc, sendCommand } = setup();
    expect(await svc.getView("u1", "s1")).toEqual({ report: null });
    expect(sendCommand).not.toHaveBeenCalled();
  });
  it("404s an unknown server and 403s a non-member", async () => {
    await expect(setup({ server: null }).svc.getView("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup({ role: null }).svc.getView("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("a corrupt stored row degrades to never scanned", async () => {
    const { svc } = setup({ server: { id: "s1", teamId: "t1", scanReport: { v: 0 }, scannedAt: NOW } });
    expect(await svc.getView("u1", "s1")).toEqual({ report: null });
  });
});

describe("ServerScanService.run", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it("requires servers:ops on the server's team", async () => {
    const perm = jest.fn().mockRejectedValue(new ForbiddenException("no"));
    const { svc, sendCommand } = setup({ perm });
    await expect(svc.run("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(perm).toHaveBeenCalledWith("u1", "t1", "servers:ops");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("runs both probes on the bulk capability, stores the report and audits counts only", async () => {
    const { svc, sendCommand, update, audit } = setup();
    const v = await svc.run("u1", "s1");
    expect(sendCommand).toHaveBeenCalledWith("s1", buildDockerScanScript(), "bulk", expect.any(Number));
    expect(sendCommand).toHaveBeenCalledWith("s1", buildHostScanScript(), "bulk", expect.any(Number));
    expect(v.report?.software.map((s) => s.id).sort()).toEqual(["docker", "nginx", "redis"]);
    expect(update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { scanReport: v.report, scannedAt: NOW, scanExposedCount: v.report?.exposed.length } });
    const log = (audit.log as jest.Mock).mock.calls[0][0];
    expect(log).toMatchObject({ actor: "u1", action: "server.scan", target: "s1" });
    expect(JSON.stringify(log)).not.toMatch(/redis|cache/);
  });

  it("returns the cached report inside the throttle window without agent traffic", async () => {
    const first = setup();
    const v = await first.svc.run("u1", "s1");
    const { svc, sendCommand } = setup({ server: { id: "s1", teamId: "t1", scanReport: v.report, scannedAt: new Date(NOW.getTime() - 3000) } });
    const again = await svc.run("u1", "s1");
    expect(again.report).toEqual(v.report);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("collapses concurrent scans of one server into one run", async () => {
    const { svc, sendCommand } = setup();
    const [a, b] = await Promise.all([svc.run("u1", "s1"), svc.run("u1", "s1")]);
    expect(a).toBe(b);
    expect(sendCommand).toHaveBeenCalledTimes(2); // docker + host, once
  });

  it("an offline agent is surfaced as such, nothing is stored", async () => {
    const send = jest.fn().mockRejectedValue(new AgentOfflineException("s1"));
    const { svc, update } = setup({ send });
    await expect(svc.run("u1", "s1")).rejects.toBeInstanceOf(AgentOfflineException);
    expect(update).not.toHaveBeenCalled();
  });

  it("a revoked capability grant is a 403", async () => {
    const send = jest.fn().mockRejectedValue(new ForbiddenException("capability"));
    await expect(setup({ send }).svc.run("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("host probe failing still yields a docker report that says why the host part is missing", async () => {
    const send = jest.fn().mockImplementation(async (_i: string, script: string) => {
      if (script === buildHostScanScript()) throw new Error("timeout");
      return { exitCode: 0, output: DOCKER_OUT };
    });
    const v = await setup({ send }).svc.run("u1", "s1");
    expect(v.report?.host).toEqual({ status: "unavailable", reason: "failed" });
    expect(v.report?.containers).toHaveLength(1);
  });

  it("an old agent image (empty host output) is reported as agent_outdated, docker part intact", async () => {
    const send = jest.fn().mockImplementation(async (_i: string, script: string) => ({
      exitCode: 0,
      output: script === buildHostScanScript() ? "TUGRA_SCAN_HOST_BEGIN\n\nTUGRA_SCAN_HOST_END\n" : DOCKER_OUT,
    }));
    const v = await setup({ send }).svc.run("u1", "s1");
    expect(v.report?.host.reason).toBe("agent_outdated");
  });

  it("both probes failing is a 503 and stores nothing (never an empty 'nothing runs here' report)", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 1, output: "" });
    const { svc, update } = setup({ send });
    await expect(svc.run("u1", "s1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(update).not.toHaveBeenCalled();
  });

  it("the 503 says why: agent timeout vs. unusable output", async () => {
    const timeout = jest.fn().mockRejectedValue(new AgentCommandTimeoutException());
    await expect(setup({ send: timeout }).svc.run("u1", "s1")).rejects.toThrow(/did not answer in time/);
    const empty = jest.fn().mockResolvedValue({ exitCode: 1, output: "" });
    await expect(setup({ send: empty }).svc.run("u1", "s1")).rejects.toThrow(/no usable output/);
  });

  it("a failure while storing the report is a 503 with a reason, never a raw 500", async () => {
    const { svc, update } = setup();
    update.mockRejectedValue(new Error("connection terminated"));
    const err = await svc.run("u1", "s1").catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(String(err.message)).toMatch(/could not be assembled or saved/);
    expect(String(err.message)).not.toMatch(/connection terminated/); // the cause is logged, not leaked
  });

  it("a docker-less host with a working host probe is a valid report", async () => {
    const send = jest.fn().mockImplementation(async (_i: string, script: string) => ({ exitCode: 0, output: script === buildHostScanScript() ? HOST_OUT : "TUGRA_NO_DOCKER\n" }));
    const v = await setup({ send }).svc.run("u1", "s1");
    expect(v.report?.docker.available).toBe(false);
    expect(v.report?.software.map((s) => s.id)).toEqual(["nginx"]);
  });
});

describe("ServerOpsController scan routes", () => {
  const meta = (fn: unknown, key: string) => Reflect.getMetadata(key, fn as object);
  it("wires GET scan (no scope, membership) and POST scan (scope deploy)", () => {
    const proto = ServerOpsController.prototype;
    expect(meta(proto.getScan, "path")).toBe("scan");
    expect(meta(proto.getScan, "method")).toBe(0);
    expect(meta(proto.getScan, REQUIRE_SCOPES)).toBeUndefined();
    expect(meta(proto.runScan, "path")).toBe("scan");
    expect(meta(proto.runScan, "method")).toBe(1);
    expect(meta(proto.runScan, "__httpCode__")).toBe(200);
    expect(meta(proto.runScan, REQUIRE_SCOPES)).toEqual(["deploy"]);
  });
});
