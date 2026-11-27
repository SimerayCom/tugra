import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ImporterService } from "./importer.service";

/** The owner's Coolify team to Tugra team mapping on an agent session. */

const session = (over: Record<string, unknown> = {}) => ({
  id: "sess-a", teamId: "t1", actorId: "u1", sourceKind: "coolify", baseUrl: "agent://srv-agent", tokenEnc: "", transport: "agent", agentServerId: "srv-agent",
  scopeKey: "", status: "active", expiresAt: new Date(Date.now() + 60_000), hostLinks: null, sourceTeamRef: null, teamMap: null, ...over,
});

function make(o: { session?: Record<string, unknown> | null; notOwnerOf?: string[] } = {}) {
  const row = o.session === null ? null : session(o.session);
  const importSession = { findUnique: jest.fn().mockResolvedValue(row), update: jest.fn().mockResolvedValue({}) };
  const access = {
    requireRole: jest.fn(async (_u: string, teamId: string, _roles?: unknown) => {
      if (o.notOwnerOf?.includes(teamId)) throw new ForbiddenException("insufficient role for this team");
    }),
  };
  const audit = { log: jest.fn() };
  const svc = new ImporterService({} as never, { importSession } as never, {} as never, access as never, audit as never, {} as never);
  return { svc, importSession, access, audit };
}

const body = (teams: Array<{ sourceTeamRef: string; teamId: string | null }>) => ({ teams }) as never;

describe("ImporterService.setTeamMap", () => {
  it("stores the mapping as ids on the session (null = left out) and audits counts only", async () => {
    const m = make();
    const r = await m.svc.setTeamMap("u1", "sess-a", body([{ sourceTeamRef: "1", teamId: "t1" }, { sourceTeamRef: "2", teamId: null }]));
    expect(r.teamMap).toEqual({ "1": "t1", "2": null });
    expect(m.importSession.update).toHaveBeenCalledWith({ where: { id: "sess-a" }, data: { teamMap: { "1": "t1", "2": null } } });
    expect(m.audit.log).toHaveBeenCalledWith({ actor: "u1", action: "import.team_map", target: "sess-a", meta: { teams: 2, left: 1 } });
  });

  it("requires the caller to own every Tugra team it names, once each, before storing anything", async () => {
    const m = make({ notOwnerOf: ["t2"] });
    await expect(m.svc.setTeamMap("u1", "sess-a", body([{ sourceTeamRef: "1", teamId: "t1" }, { sourceTeamRef: "2", teamId: "t2" }, { sourceTeamRef: "3", teamId: "t2" }]))).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.importSession.update).not.toHaveBeenCalled();
    expect(m.access.requireRole.mock.calls.filter((c) => c[1] === "t2")).toHaveLength(1);
    expect(m.access.requireRole.mock.calls[0][2]).toEqual(["OWNER"]);
  });

  it("a team left out needs no role", async () => {
    const m = make({ notOwnerOf: ["t1"] });
    await m.svc.setTeamMap("u1", "sess-a", body([{ sourceTeamRef: "1", teamId: null }]));
    expect(m.access.requireRole).not.toHaveBeenCalled();
  });

  it("refuses another user's session, an ended one, a token session and a duplicate Coolify team", async () => {
    await expect(make({ session: { actorId: "u2" } }).svc.setTeamMap("u1", "sess-a", body([{ sourceTeamRef: "1", teamId: null }]))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ session: { expiresAt: new Date(Date.now() - 1) } }).svc.setTeamMap("u1", "sess-a", body([{ sourceTeamRef: "1", teamId: null }]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ session: { transport: "api" } }).svc.setTeamMap("u1", "sess-a", body([{ sourceTeamRef: "1", teamId: null }]))).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ session: null }).svc.setTeamMap("u1", "sess-a", body([{ sourceTeamRef: "1", teamId: null }]))).rejects.toBeInstanceOf(NotFoundException);
    await expect(make().svc.setTeamMap("u1", "sess-a", body([{ sourceTeamRef: "1", teamId: "t1" }, { sourceTeamRef: "1", teamId: null }]))).rejects.toBeInstanceOf(BadRequestException);
  });
});
