import { RunEnvService } from "./run-env.service";

function make(session: Record<string, unknown> | null) {
  const prisma = { importSession: { findUnique: jest.fn().mockResolvedValue(session) } };
  return new RunEnvService(prisma as never, {} as never, {} as never);
}

const row = (over: Record<string, unknown> = {}) => ({ id: "s1", teamId: "t1", actorId: "u1", sourceKind: "coolify", baseUrl: "https://Coolify.Example.com:8000", scopeKey: "", status: "active", expiresAt: new Date(Date.now() + 60_000), ...over });

describe("RunEnvService.session", () => {
  it("reads the host of a token session as before (lower-case host[:port])", async () => {
    expect(await make(row()).session("u1", "s1")).toMatchObject({ host: "coolify.example.com:8000", state: "active", baseUrl: "https://Coolify.Example.com:8000" });
  });

  it("an agent session (synthetic agent://<serverId> URL) resolves without error: the URL parse never breaks the run", async () => {
    const s = await make(row({ baseUrl: "agent://srv-agent", transport: "agent" })).session("u1", "s1");
    expect(s).toMatchObject({ id: "s1", baseUrl: "agent://srv-agent", host: "srv-agent", state: "active" });
  });

  it("an unparsable base URL leaves the host empty instead of throwing", async () => {
    expect(await make(row({ baseUrl: "not a url" })).session("u1", "s1")).toMatchObject({ host: "" });
  });

  it("is only the actor's own remote session", async () => {
    expect(await make(row({ actorId: "other" })).session("u1", "s1")).toBeNull();
    expect(await make(row({ sourceKind: "local-docker" })).session("u1", "s1")).toBeNull();
    expect(await make(null).session("u1", "s1")).toBeNull();
  });
});
