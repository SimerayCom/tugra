import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { COOLIFY_SECRET_CLASSES, COOLIFY_SECRET_TIER } from "@tugra/shared";
import { grantHarness } from "./coolify-grant.testing";

const T1 = COOLIFY_SECRET_CLASSES.filter((c) => COOLIFY_SECRET_TIER[c] === "T1");
const ok = { serverId: "s1", confirm: "coolify-host" };

describe("CoolifyHostGrantService: creating consent", () => {
  it("is team OWNER only (an ADMIN or a stranger is refused and nothing is created)", async () => {
    for (const roles of [{ t1: Role.ADMIN }, { t1: Role.VIEWER }, {}]) {
      const h = await grantHarness({ roles: roles as any });
      await expect(h.svc.createSecretsGrant("u1", ok)).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.table.rows).toHaveLength(0);
      expect(h.servers.applyCoolifyRunCapability).not.toHaveBeenCalled();
    }
  });

  it("needs the typed host name (exact), and an existing server", async () => {
    const h = await grantHarness();
    for (const confirm of ["", "Coolify-host", "coolify-host ", "yes", "coolify"]) {
      await expect(h.svc.createSecretsGrant("u1", { ...ok, confirm })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(h.svc.createSecretsGrant("u1", { serverId: "nope", confirm: "x" })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.table.rows).toHaveLength(0);
  });

  it("defaults to the tier-1 classes for 24 hours; tier-2 classes only when listed", async () => {
    const h = await grantHarness();
    const before = Date.now();
    const v = await h.svc.createSecretsGrant("u1", ok);
    expect(v.classes).toEqual(T1);
    expect(v.classes).not.toContain("notification");
    expect(v.classes).not.toContain("git_app_key");
    expect(v.classes).not.toContain("deploy_key");
    const hrs = (new Date(v.expiresAt).getTime() - before) / 3_600_000;
    expect(hrs).toBeGreaterThan(23.99);
    expect(hrs).toBeLessThan(24.01);
    expect(v.status).toBe("active");

    const h2 = await grantHarness();
    const v2 = await h2.svc.createSecretsGrant("u1", { ...ok, classes: ["env", "deploy_key"] });
    expect(v2.classes).toEqual(["env", "deploy_key"]);
  });

  it("bounds the window (1 hour to 7 days) and validates classes and run id", async () => {
    const h = await grantHarness();
    for (const hours of [0, -1, 169, 1.5, NaN]) await expect(h.svc.createSecretsGrant("u1", { ...ok, hours })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.createSecretsGrant("u1", { ...ok, classes: ["app_key" as any] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.createSecretsGrant("u1", { ...ok, classes: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.createSecretsGrant("u1", { ...ok, runId: "bad id!" })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.table.rows).toHaveLength(0);
    const v = await h.svc.createSecretsGrant("u1", { ...ok, hours: 168 });
    expect(v.status).toBe("active");
  });

  it("refuses an offline agent and an agent that does not speak coolify_secrets_v1, creating nothing", async () => {
    const off = await grantHarness({ online: false });
    await expect(off.svc.createSecretsGrant("u1", ok)).rejects.toMatchObject({ response: { code: "agent_offline" } });
    const old = await grantHarness({ features: [] });
    await expect(old.svc.createSecretsGrant("u1", ok)).rejects.toMatchObject({ response: { code: "agent_too_old" } });
    for (const h of [off, old]) {
      expect(h.table.rows).toHaveLength(0);
      expect(h.servers.applyCoolifyRunCapability).not.toHaveBeenCalled();
    }
  });

  it("stores the run key wrapped (tk1), turns the capability on, audits without any key material", async () => {
    const h = await grantHarness();
    const v = await h.svc.createSecretsGrant("u1", { ...ok, runId: "run-7" });
    const row = h.table.rows[0];
    expect(row.recipientKeyEnc).toMatch(/^tk1\.[0-9a-f]{16}\./);
    expect(row.recipientPublicKey).not.toBe(row.recipientKeyEnc);
    expect(row.runId).toBe("run-7");
    expect(h.server.capabilities).toContain("coolify_secrets");
    expect(h.servers.applyCoolifyRunCapability).toHaveBeenCalledWith("s1", "coolify_secrets", true);
    const audited = JSON.stringify(h.audit.log.mock.calls);
    expect(audited).toContain("coolify.secrets.grant");
    expect(audited).not.toContain(row.recipientKeyEnc);
    expect(audited).not.toContain(row.recipientPublicKey);
    // the API view never carries key material or the run id
    const text = JSON.stringify(v);
    expect(text).not.toContain(row.recipientKeyEnc);
    expect(text).not.toContain(row.recipientPublicKey);
    expect(v).not.toHaveProperty("recipientKeyEnc");
    expect(v).not.toHaveProperty("runId");
  });

  it("is idempotent for the same classes (two admins clicking get one grant) and refuses different classes", async () => {
    const h = await grantHarness();
    const a = await h.svc.createSecretsGrant("u1", ok);
    const b = await h.svc.createSecretsGrant("u1", ok);
    expect(b.id).toBe(a.id);
    expect(h.table.rows).toHaveLength(1);
    await expect(h.svc.createSecretsGrant("u1", { ...ok, classes: ["env"] })).rejects.toBeInstanceOf(ConflictException);
    expect(h.table.rows).toHaveLength(1);
  });
});

describe("CoolifyHostGrantService: ending consent", () => {
  it("revoke is owner only, destroys the key, drops the capability and audits", async () => {
    const h = await grantHarness();
    const v = await h.svc.createSecretsGrant("u1", ok);
    expect(await h.svc.activeSecretsGrant("s1")).not.toBeNull();

    h.access.requireRole.mockRejectedValueOnce(new ForbiddenException("no"));
    await expect(h.svc.revoke("u2", v.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.table.rows[0].recipientKeyEnc).not.toBeNull(); // a refused revoke changed nothing

    const r = await h.svc.revoke("u1", v.id);
    expect(r.status).toBe("revoked");
    expect(h.table.rows[0].recipientKeyEnc).toBeNull();
    expect(h.table.rows[0].recipientPublicKey).toBeNull();
    expect(h.table.rows[0].revokedById).toBe("u1");
    expect(h.server.capabilities).not.toContain("coolify_secrets");
    expect(await h.svc.activeSecretsGrant("s1")).toBeNull();
    expect(JSON.stringify(h.audit.log.mock.calls)).toContain("coolify.secrets.revoke");
    // idempotent
    await expect(h.svc.revoke("u1", v.id)).resolves.toMatchObject({ status: "revoked" });
    await expect(h.svc.revoke("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a lapsed grant serves nothing even before the sweep runs, and the sweep then closes it", async () => {
    const h = await grantHarness();
    const v = await h.svc.createSecretsGrant("u1", { ...ok, hours: 1 });
    h.table.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await h.svc.activeSecretsGrant("s1")).toBeNull();
    expect(h.server.capabilities).toContain("coolify_secrets"); // not yet swept
    expect(await h.svc.sweep()).toBe(1);
    expect(h.server.capabilities).not.toContain("coolify_secrets");
    expect(h.table.rows[0].recipientKeyEnc).toBeNull();
    expect((await h.svc.list("u1", "t1"))[0]).toMatchObject({ id: v.id, status: "expired" });
    expect(JSON.stringify(h.audit.log.mock.calls)).toContain("expired");
    expect(await h.svc.sweep()).toBe(0); // nothing left to close
  });

  it("the run ending closes the grant like a revoke, by the system", async () => {
    const h = await grantHarness();
    const v = await h.svc.createSecretsGrant("u1", ok);
    await h.svc.finishRun(v.id);
    expect(h.table.rows[0].recipientKeyEnc).toBeNull();
    expect(h.server.capabilities).not.toContain("coolify_secrets");
    expect(JSON.stringify(h.audit.log.mock.calls.at(-1))).toContain("run_ended");
    await expect(h.svc.finishRun(v.id)).resolves.toBeUndefined();
    await expect(h.svc.finishRun("nope")).resolves.toBeUndefined();
  });

  it("the capability stays while ANOTHER active grant of the kind still needs it", async () => {
    const h = await grantHarness();
    const a = await h.svc.createSecretsGrant("u1", ok);
    // a second active row (as a later lane might create for another run) keeps the capability
    h.table.rows.push({ id: "gx", teamId: "t1", serverId: "s1", kind: "secrets", classes: ["env"], grantedById: "u1", runId: "r2", recipientPublicKey: "p", recipientKeyEnc: "k", expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, createdAt: new Date() });
    await h.svc.revoke("u1", a.id);
    expect(h.server.capabilities).toContain("coolify_secrets");
  });

  it("the sweep also drops a capability that no active grant backs (a crash between the two steps, a deleted row)", async () => {
    const h = await grantHarness();
    h.server.capabilities.push("coolify_secrets"); // held with no grant at all
    await h.svc.sweep();
    expect(h.server.capabilities).not.toContain("coolify_secrets");
    // and an active grant keeps it
    const h2 = await grantHarness();
    await h2.svc.createSecretsGrant("u1", ok);
    await h2.svc.sweep();
    expect(h2.server.capabilities).toContain("coolify_secrets");
  });

  it("listing is for OWNER and ADMIN, and returns views only", async () => {
    const h = await grantHarness({ roles: { t1: Role.ADMIN } });
    await expect(h.svc.list("u1", "t1")).resolves.toEqual([]);
    const v = await grantHarness({ roles: { t1: Role.VIEWER } });
    await expect(v.svc.list("u1", "t1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});
