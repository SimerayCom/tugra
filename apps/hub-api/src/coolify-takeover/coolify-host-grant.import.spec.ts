import { BadRequestException, NotFoundException } from "@nestjs/common";
import { grantHarness } from "./coolify-grant.testing";

const ok = { serverId: "s1", confirm: "coolify-host" };
const session = (over: Record<string, any> = {}) => ({ id: "sess1", actorId: "u1", teamId: "t1", status: "active", expiresAt: new Date(Date.now() + 3600_000), transport: "agent", agentServerId: "s1", ...over });

describe("CoolifyHostGrantService: the consent of an import belongs to its session", () => {
  it("makes the import session the run of the grant (the run id is the session id)", async () => {
    const h = await grantHarness({ sessions: { sess1: session() } });
    await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });
    expect(h.table.rows[0].runId).toBe("sess1");
    expect((await h.svc.activeSecretsGrant("s1"))?.runId).toBe("sess1");
  });

  it("refuses a session that is not the owner's own, is on another server or team, is not an agent session, or is over (nothing is created)", async () => {
    const cases: Array<Record<string, any>> = [{ actorId: "u2" }, { agentServerId: "s9" }, { teamId: "t9" }, { transport: "api" }];
    for (const over of cases) {
      const h = await grantHarness({ sessions: { sess1: session(over) } });
      await expect(h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" })).rejects.toBeInstanceOf(NotFoundException);
      expect(h.table.rows).toHaveLength(0);
      expect(h.servers.applyCoolifyRunCapability).not.toHaveBeenCalled();
    }
    for (const over of [{ status: "revoked" }, { expiresAt: new Date(Date.now() - 1000) }]) {
      const h = await grantHarness({ sessions: { sess1: session(over) } });
      await expect(h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" })).rejects.toBeInstanceOf(BadRequestException);
      expect(h.table.rows).toHaveLength(0);
    }
    const none = await grantHarness();
    await expect(none.svc.createSecretsGrant("u1", { ...ok, importSessionId: "ghost" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("asking again for the same session is the same grant (two clicks, one run)", async () => {
    const h = await grantHarness({ sessions: { sess1: session() } });
    const a = await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });
    const b = await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });
    expect(b.id).toBe(a.id);
    expect(h.table.rows).toHaveLength(1);
  });

  it("a consent for a new import replaces the one an earlier run left standing: the old key is destroyed, one grant stays active", async () => {
    const h = await grantHarness({ sessions: { sess1: session(), sess2: session({ id: "sess2" }) } });
    const first = await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });
    const second = await h.svc.createSecretsGrant("u1", { ...ok, classes: ["env"], importSessionId: "sess2" });
    expect(second.id).not.toBe(first.id);
    const old = h.table.rows.find((r) => r.id === first.id)!;
    expect(old.recipientKeyEnc).toBeNull();
    expect(old.recipientPublicKey).toBeNull();
    expect((await h.svc.activeSecretsGrant("s1"))?.runId).toBe("sess2");
    expect(h.server.capabilities).toContain("coolify_secrets"); // handed over, not dropped
    expect(JSON.stringify(h.audit.log.mock.calls)).toContain("superseded");
  });

  it("a grant made outside an import still refuses different classes without a run (it is not replaced behind the owner's back)", async () => {
    const h = await grantHarness();
    await h.svc.createSecretsGrant("u1", ok);
    await expect(h.svc.createSecretsGrant("u1", { ...ok, classes: ["env"] })).rejects.toMatchObject({ response: { code: "grant_active" } });
  });

  it("finishRunByRunId ends only the grant of that run, on that server, and is idempotent", async () => {
    const h = await grantHarness({ sessions: { sess1: session() } });
    await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });
    await h.svc.finishRunByRunId("s1", "other-run");
    expect(await h.svc.activeSecretsGrant("s1")).not.toBeNull(); // not this run's
    await h.svc.finishRunByRunId("s2", "sess1");
    expect(await h.svc.activeSecretsGrant("s1")).not.toBeNull(); // not this server's
    await h.svc.finishRunByRunId("s1", "sess1");
    expect(await h.svc.activeSecretsGrant("s1")).toBeNull();
    expect(h.table.rows[0].recipientKeyEnc).toBeNull();
    expect(h.server.capabilities).not.toContain("coolify_secrets");
    expect(JSON.stringify(h.audit.log.mock.calls.at(-1))).toContain("run_ended");
    await expect(h.svc.finishRunByRunId("s1", "sess1")).resolves.toBeUndefined();
  });
});
