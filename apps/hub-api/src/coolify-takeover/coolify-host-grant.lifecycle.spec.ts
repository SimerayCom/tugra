import { grantHarness } from "./coolify-grant.testing";

const ok = { serverId: "s1", confirm: "coolify-host" };
const HOUR = 3_600_000;
const session = (over: Record<string, any> = {}) => ({ id: "sess1", actorId: "u1", teamId: "t1", status: "active", expiresAt: new Date(Date.now() + HOUR), transport: "agent", agentServerId: "s1", ...over });

describe("CoolifyHostGrantService: the consent of an import has its own window and never outlives its session", () => {
  it("is not capped at the session's current end any more (the session lives on while it is used): its own window, capped at the session's hard end", async () => {
    const createdAt = new Date(Date.now() - 2 * HOUR);
    const h = await grantHarness({ sessions: { sess1: session({ createdAt, expiresAt: new Date(Date.now() + 20 * 60_000) }) } });
    const v = await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1", hours: 168 });
    // 12 h from the session's creation (default hard end), 2 h of which are behind us
    expect(new Date(v.expiresAt).getTime()).toBe(createdAt.getTime() + 12 * HOUR);
    const short = await grantHarness({ sessions: { sess1: session({ createdAt, expiresAt: new Date(Date.now() + 20 * 60_000) }) } });
    const s = await short.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1", hours: 2 });
    expect((new Date(s.expiresAt).getTime() - Date.now()) / HOUR).toBeGreaterThan(1.99); // longer than the 20 minutes the session had left
  });

  it("giving the consent is an action on the session: its end moves to now plus an hour", async () => {
    const h = await grantHarness({ sessions: { sess1: session({ createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60_000) }) } });
    await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });
    expect(h.prisma.importSession.updateMany).toHaveBeenCalledTimes(1);
    const end = (await h.prisma.importSession.findUnique({ where: { id: "sess1" } })).expiresAt.getTime();
    expect((end - Date.now()) / 60_000).toBeGreaterThan(59);
  });

  it("keeps the asked window when it is shorter than the hard end, and a run-less consent keeps its own window", async () => {
    const h = await grantHarness({ sessions: { sess1: session({ createdAt: new Date(), expiresAt: new Date(Date.now() + 5 * HOUR) }) } });
    const v = await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1", hours: 1 });
    expect((new Date(v.expiresAt).getTime() - Date.now()) / HOUR).toBeLessThan(1.01);
    const free = await grantHarness();
    const f = await free.svc.createSecretsGrant("u1", { ...ok, hours: 72 });
    expect((new Date(f.expiresAt).getTime() - Date.now()) / HOUR).toBeGreaterThan(71.9);
  });

  it("the sweep ends a grant whose session was revoked, expired or deleted, and leaves the others alone", async () => {
    const sessions: Record<string, any> = { live: session({ id: "live" }), revoked: session({ id: "revoked" }), old: session({ id: "old" }), gone: session({ id: "gone" }) };
    const h = await grantHarness({ sessions });
    // a second server per grant is not needed: the harness allows one active grant per host, so seed the rows directly
    const now = new Date();
    const seed = (id: string, runId: string) =>
      h.table.rows.push({ id, teamId: "t1", serverId: "s1", kind: "secrets", classes: ["env"], grantedById: "u1", runId, recipientPublicKey: "pub", recipientKeyEnc: "tk1.x", expiresAt: new Date(now.getTime() + 24 * HOUR), revokedAt: null, createdAt: now });
    seed("g-live", "live");
    seed("g-revoked", "revoked");
    seed("g-old", "old");
    seed("g-gone", "gone");
    seed("g-free", "cfy-123");
    sessions.revoked.status = "revoked";
    sessions.old.expiresAt = new Date(now.getTime() - 1000);
    delete sessions.gone;

    await h.svc.sweep(now);

    const ended = (id: string) => h.table.rows.find((r) => r.id === id)!.recipientKeyEnc === null;
    expect(ended("g-revoked")).toBe(true);
    expect(ended("g-old")).toBe(true);
    expect(ended("g-gone")).toBe(true);
    expect(ended("g-live")).toBe(false);
    expect(ended("g-free")).toBe(false); // a consent given without an import has no session to follow
    expect(JSON.stringify(h.audit.log.mock.calls)).toContain("session_ended");
  });

  it("the sweep drops the agent capability once the last orphaned grant is gone", async () => {
    const h = await grantHarness({ sessions: { sess1: session() } });
    await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });
    expect(h.server.capabilities).toContain("coolify_secrets");
    h.prisma.importSession.findMany.mockImplementation(async () => []);
    await h.svc.sweep();
    expect(await h.svc.activeSecretsGrant("s1")).toBeNull();
    expect(h.server.capabilities).not.toContain("coolify_secrets");
  });
});

describe("CoolifyHostGrantService: withdrawing the opt-in ends the consent", () => {
  it("endSecretsForServer ends every secrets grant of that server (key destroyed, capability dropped), and no other server's", async () => {
    const h = await grantHarness({ sessions: { sess1: session() } });
    await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });
    expect(await h.svc.endSecretsForServer("s2")).toBe(0);
    expect(await h.svc.activeSecretsGrant("s1")).not.toBeNull();
    expect(await h.svc.endSecretsForServer("s1")).toBe(1);
    expect(await h.svc.activeSecretsGrant("s1")).toBeNull();
    expect(h.table.rows[0].recipientKeyEnc).toBeNull();
    expect(h.server.capabilities).not.toContain("coolify_secrets");
    expect(JSON.stringify(h.audit.log.mock.calls.at(-1))).toContain("opt_in_withdrawn");
    expect(await h.svc.endSecretsForServer("s1")).toBe(0); // idempotent
  });
});
