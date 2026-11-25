import { BadRequestException, ForbiddenException, Logger } from "@nestjs/common";
import type { CoolifySecretClass, CoolifySecretRecord } from "@tugra/shared";
import { grantHarness } from "./coolify-grant.testing";
import { CoolifySecretsRemoteException } from "../agent-gateway/agent-ws.server";
import { CoolifySecretsService } from "./coolify-secrets.service";
import { sealForTest } from "./sealed-channel.testing";

const ok = { serverId: "s1", confirm: "coolify-host" };

interface Plan {
  /** ref|field -> plaintext, sealed for the request's recipient key and context */
  values?: Record<string, { cls: CoolifySecretClass; plain: string }>;
  /** extra records the (untrusted) agent sends */
  extra?: (req: { runId: string; recipientKey: string }) => CoolifySecretRecord[];
  failWith?: Error;
}

async function make(plan: Plan = {}, hours = 24) {
  const h = await grantHarness();
  const requests: Array<{ runId: string; classes: string[]; refs: string[]; recipientKey: string }> = [];
  const agentWs = {
    sendCoolifySecrets: jest.fn(async (serverId: string, req: { runId: string; classes: string[]; refs: string[]; recipientKey: string }) => {
      requests.push(req);
      if (plan.failWith) throw plan.failWith;
      const recs: CoolifySecretRecord[] = [];
      for (const [k, v] of Object.entries(plan.values ?? {})) {
        const [ref, field] = k.split("|");
        if (!req.refs.includes(ref)) continue;
        recs.push({ ref, field, class: v.cls, env: sealForTest(req.recipientKey, { runId: req.runId, serverId, ref, field, cls: v.cls }, v.plain) });
      }
      return [...recs, ...(plan.extra?.(req) ?? [])];
    }),
  } as any;
  const svc = new CoolifySecretsService(h.svc, h.sealed, agentWs, h.crypto, h.audit);
  const grant = await h.svc.createSecretsGrant("u1", { ...ok, hours });
  return { ...h, svc2: svc, agentWs, requests, grant };
}

describe("CoolifySecretsService: reading sealed values", () => {
  it("opens each value into the sink and stores only tk1 ciphertext", async () => {
    const t = await make({ values: { "env:a|value": { cls: "env", plain: "postgres://app:hunter2@db/app" }, "s3:b|secret": { cls: "s3", plain: "s3-secret-xyz" } } });
    const r = await t.svc2.fetchEncrypted({ serverId: "s1", refs: ["env:a", "s3:b"], userId: "u1" });
    expect(r.read).toBe(2);
    expect(r.unreadable).toEqual([]);
    expect(r.values.map((v) => `${v.ref}|${v.field}`).sort()).toEqual(["env:a|value", "s3:b|secret"]);
    for (const v of r.values) {
      expect(v.enc).toMatch(/^tk1\.[0-9a-f]{16}\./);
      expect(v.enc).not.toContain("hunter2");
    }
    const a = r.values.find((v) => v.ref === "env:a")!;
    expect(t.crypto.decrypt(a.enc)).toBe("postgres://app:hunter2@db/app");
  });

  it("sends the grant's run id and PUBLIC key, never the wrapped private key, and only the asked classes", async () => {
    const t = await make({ values: { "env:a|value": { cls: "env", plain: "v" } } });
    await t.svc2.fetch({ serverId: "s1", refs: ["env:a"], classes: ["env"] }, () => undefined);
    const req = t.requests[0];
    expect(req.classes).toEqual(["env"]);
    expect(req.recipientKey).toBe(t.table.rows[0].recipientPublicKey);
    expect(req.runId).toBe(t.table.rows[0].runId);
    expect(JSON.stringify(req)).not.toContain(t.table.rows[0].recipientKeyEnc);
  });

  it("needs an active grant: none, revoked and lapsed all refuse and never ask the agent", async () => {
    const none = await grantHarness();
    const svcNone = new CoolifySecretsService(none.svc, none.sealed, { sendCoolifySecrets: jest.fn() } as any, none.crypto, none.audit);
    await expect(svcNone.fetch({ serverId: "s1", refs: ["env:a"] }, () => undefined)).rejects.toMatchObject({ response: { code: "no_active_grant" } });

    const t = await make();
    await t.svc.revoke("u1", t.grant.id);
    await expect(t.svc2.fetch({ serverId: "s1", refs: ["env:a"] }, () => undefined)).rejects.toBeInstanceOf(ForbiddenException);
    const lapsed = await make();
    lapsed.table.rows[0].expiresAt = new Date(Date.now() - 1);
    await expect(lapsed.svc2.fetch({ serverId: "s1", refs: ["env:a"] }, () => undefined)).rejects.toBeInstanceOf(ForbiddenException);
    for (const x of [t, lapsed]) expect(x.agentWs.sendCoolifySecrets).not.toHaveBeenCalled();
  });

  it("refuses a class the owner did not consent to (tier-2 stays closed) and bad refs", async () => {
    const t = await make();
    await expect(t.svc2.fetch({ serverId: "s1", refs: ["private_key:k1"], classes: ["deploy_key"] }, () => undefined)).rejects.toMatchObject({ response: { code: "class_not_granted" } });
    await expect(t.svc2.fetch({ serverId: "s1", refs: ["env:a"], classes: ["app_key" as any] }, () => undefined)).rejects.toBeInstanceOf(ForbiddenException);
    for (const bad of ["env", "env:a'b", "env:a b", "ENV:a", "", "env:a\nb"]) {
      await expect(t.svc2.fetch({ serverId: "s1", refs: [bad] }, () => undefined)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(t.svc2.fetch({ serverId: "s1", refs: [] }, () => undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.agentWs.sendCoolifySecrets).not.toHaveBeenCalled();
  });

  it("splits more than 200 refs into frames of at most 200 and re-checks the grant before each", async () => {
    const t = await make();
    const refs = Array.from({ length: 450 }, (_, i) => `env:r${i}`);
    await t.svc2.fetch({ serverId: "s1", refs }, () => undefined);
    expect(t.requests.map((r) => r.refs.length)).toEqual([200, 200, 50]);

    // revoked after the first frame: the second is never sent
    const u = await make();
    u.agentWs.sendCoolifySecrets.mockImplementationOnce(async () => {
      await u.svc.revoke("u1", u.grant.id);
      return [];
    });
    await expect(u.svc2.fetch({ serverId: "s1", refs }, () => undefined)).rejects.toMatchObject({ response: { code: "no_active_grant" } });
    expect(u.agentWs.sendCoolifySecrets).toHaveBeenCalledTimes(1);
  });

  it("reports what could not be read with a fixed code (nothing is skipped silently) and notes a previous key", async () => {
    const t = await make({
      values: { "env:ok|value": { cls: "env", plain: "fine" } },
      extra: () => [
        { ref: "env:bad", field: "value", code: "bad_mac" },
        { ref: "env:obj", field: "value", code: "unsupported_serialization" },
        { ref: "env:ok", field: "*", code: "key_prev" },
      ],
    });
    const r = await t.svc2.fetchEncrypted({ serverId: "s1", refs: ["env:ok", "env:bad", "env:obj"] });
    expect(r.read).toBe(1);
    expect(r.unreadable).toEqual([
      { itemRef: "env:bad", field: "value", code: "bad_mac" },
      { itemRef: "env:obj", field: "value", code: "unsupported_serialization" },
    ]);
    expect(r.usedPreviousKey).toBe(true);
  });

  it("treats the agent as untrusted: drops unasked refs, classes outside the consent, odd fields and plaintext in place of an envelope", async () => {
    const t = await make({
      values: { "env:a|value": { cls: "env", plain: "real" } },
      extra: (req) => [
        { ref: "env:never-asked", field: "value", class: "env", env: sealForTest(req.recipientKey, { runId: req.runId, serverId: "s1", ref: "env:never-asked", field: "value", cls: "env" }, "injected") },
        { ref: "env:a", field: "value", class: "deploy_key", env: sealForTest(req.recipientKey, { runId: req.runId, serverId: "s1", ref: "env:a", field: "value", cls: "deploy_key" }, "tier2") },
        { ref: "env:a", field: "Bad Field!", class: "env", env: "tse1.AAAA" },
        { ref: "env:a", field: "value", code: "ok" },
        { ref: "env:a", field: "value", code: "any text the agent likes" },
        { ref: "env:a", field: "value", class: "env", env: "plaintext-not-an-envelope" },
        null as any,
      ],
    });
    const seen: string[] = [];
    const r = await t.svc2.fetch({ serverId: "s1", refs: ["env:a"] }, (s) => void seen.push(`${s.ref}=${s.value}`));
    expect(seen).toEqual(["env:a=real"]);
    expect(r.read).toBe(1);
    // the one that LOOKS like an envelope slot but is not one is reported unreadable, with a fixed code
    expect(r.unreadable).toEqual([{ itemRef: "env:a", field: "value", code: "bad_payload" }]);
  });

  it("an envelope sealed for another run, agent or field is unreadable, never a value", async () => {
    const t = await make({
      extra: (req) => [
        { ref: "env:a", field: "value", class: "env", env: sealForTest(req.recipientKey, { runId: "other-run", serverId: "s1", ref: "env:a", field: "value", cls: "env" }, "x") },
        { ref: "env:a", field: "value", class: "env", env: sealForTest(req.recipientKey, { runId: req.runId, serverId: "s2", ref: "env:a", field: "value", cls: "env" }, "x") },
        { ref: "env:a", field: "value", class: "env", env: sealForTest(req.recipientKey, { runId: req.runId, serverId: "s1", ref: "env:a", field: "other", cls: "env" }, "x") },
      ],
    });
    const seen: string[] = [];
    const r = await t.svc2.fetch({ serverId: "s1", refs: ["env:a"] }, (s) => void seen.push(s.value));
    expect(seen).toEqual([]);
    expect(r.unreadable).toHaveLength(3);
  });

  it("passes an agent failure on and audits it by class name only", async () => {
    const t = await make({ failWith: Object.assign(new Error("boom with s3cr3t inside"), { name: "Boom" }) });
    await expect(t.svc2.fetch({ serverId: "s1", refs: ["env:a"], userId: "u1" }, () => undefined)).rejects.toThrow();
    const entry = t.audit.log.mock.calls.map((c: any[]) => c[0]).find((e: any) => e.action === "coolify.secrets.read");
    expect(entry.meta.failure).toBe("Error");
    expect(JSON.stringify(entry)).not.toContain("s3cr3t");
  });
});

describe("CoolifySecretsService: a large fleet against the agent's rate window", () => {
  const manyRefs = (n: number) => Array.from({ length: n }, (_, i) => `env:r${i}`);
  const valuesFor = (n: number) => Object.fromEntries(manyRefs(n).map((r, i) => [`${r}|value`, { cls: "env" as const, plain: `plain-${i}` }]));

  it("waits and retries on rate_limited and busy, and reads all 1,240 values", async () => {
    const t = await make({ values: valuesFor(1240) });
    const sleeps: number[] = [];
    t.svc2.sleep = async (ms) => void sleeps.push(ms);
    const real = t.agentWs.sendCoolifySecrets.getMockImplementation()!;
    let calls = 0;
    t.agentWs.sendCoolifySecrets.mockImplementation(async (...a: any[]) => {
      calls++;
      if (calls === 7) throw new CoolifySecretsRemoteException("rate_limited");
      if (calls === 8) throw new CoolifySecretsRemoteException("busy");
      return (real as any)(...a);
    });
    const r = await t.svc2.fetchEncrypted({ serverId: "s1", refs: manyRefs(1240), userId: "u1" });
    expect(r.read).toBe(1240);
    expect(r.values).toHaveLength(1240);
    expect(r.incomplete).toBeUndefined();
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(t.requests.map((q) => q.refs.length)).toEqual([200, 200, 200, 200, 200, 200, 40]);
    const a = r.values.find((v) => v.ref === "env:r1239")!;
    expect(t.crypto.decrypt(a.enc)).toBe("plain-1239");
  });

  it("re-checks the grant before every retry: revoked while waiting stops the read", async () => {
    const t = await make({ values: valuesFor(10) });
    t.agentWs.sendCoolifySecrets.mockImplementation(async () => {
      throw new CoolifySecretsRemoteException("rate_limited");
    });
    t.svc2.sleep = async () => {
      await t.svc.revoke("u1", t.grant.id);
    };
    await expect(t.svc2.fetch({ serverId: "s1", refs: manyRefs(10) }, () => undefined)).rejects.toMatchObject({ response: { code: "no_active_grant" } });
    expect(t.agentWs.sendCoolifySecrets).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of retries", async () => {
    const t = await make();
    t.svc2.sleep = async () => undefined;
    t.agentWs.sendCoolifySecrets.mockImplementation(async () => {
      throw new CoolifySecretsRemoteException("rate_limited");
    });
    await expect(t.svc2.fetch({ serverId: "s1", refs: ["env:a"] }, () => undefined)).rejects.toMatchObject({ code: "rate_limited" });
    expect(t.agentWs.sendCoolifySecrets).toHaveBeenCalledTimes(9);
  });

  it("does not retry other refusals (denied, expired, failed...)", async () => {
    for (const code of ["denied", "expired", "replay", "failed", "revoked", "bad_request"]) {
      const t = await make();
      t.svc2.sleep = async () => {
        throw new Error("must not wait");
      };
      t.agentWs.sendCoolifySecrets.mockImplementation(async () => {
        throw new CoolifySecretsRemoteException(code);
      });
      await expect(t.svc2.fetch({ serverId: "s1", refs: ["env:a"] }, () => undefined)).rejects.toMatchObject({ code });
      expect(t.agentWs.sendCoolifySecrets).toHaveBeenCalledTimes(1);
    }
  });

  it("fetchEncrypted keeps the values of finished frames when a later frame fails, and reports what is left", async () => {
    const t = await make({ values: valuesFor(450) });
    t.svc2.sleep = async () => undefined;
    const real = t.agentWs.sendCoolifySecrets.getMockImplementation()!;
    let calls = 0;
    t.agentWs.sendCoolifySecrets.mockImplementation(async (...a: any[]) => {
      calls++;
      if (calls >= 2) throw new CoolifySecretsRemoteException("denied");
      return (real as any)(...a);
    });
    const r = await t.svc2.fetchEncrypted({ serverId: "s1", refs: manyRefs(450), userId: "u1" });
    expect(r.read).toBe(200);
    expect(r.values).toHaveLength(200);
    expect(r.incomplete?.code).toBe("denied");
    expect(r.incomplete?.remainingRefs).toEqual(manyRefs(450).slice(200));
    const entry = t.audit.log.mock.calls.map((c: any[]) => c[0]).find((e: any) => e.action === "coolify.secrets.read");
    expect(entry.meta).toMatchObject({ read: 200, incomplete: "denied", remaining: 250 });
    expect(JSON.stringify(entry)).not.toContain("plain-");
    expect(JSON.stringify(entry)).not.toContain("env:r");
  });

  it("fetch without keepPartial still throws on a failed frame", async () => {
    const t = await make({ values: valuesFor(450) });
    let calls = 0;
    const real = t.agentWs.sendCoolifySecrets.getMockImplementation()!;
    t.agentWs.sendCoolifySecrets.mockImplementation(async (...a: any[]) => {
      if (++calls === 2) throw new CoolifySecretsRemoteException("failed");
      return (real as any)(...a);
    });
    await expect(t.svc2.fetch({ serverId: "s1", refs: manyRefs(450) }, () => undefined)).rejects.toMatchObject({ code: "failed" });
  });
});

// The hub-side canary test: known plaintexts go through the whole read, then everything the hub could emit or persist is searched for them.
describe("CoolifySecretsService: canary leak test (hub side)", () => {
  const CANARIES = { env: "cnr-hub-env-91f3a7c2d4", db: "cnr-hub-dbp-5be0c81aa9", s3: "cnr-hub-s3s-77d1e4f0b6" };

  function spyAll() {
    const sinks: string[] = [];
    const rec = (...a: unknown[]) => void sinks.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    const spies = [
      jest.spyOn(console, "log").mockImplementation(rec as any),
      jest.spyOn(console, "warn").mockImplementation(rec as any),
      jest.spyOn(console, "error").mockImplementation(rec as any),
      jest.spyOn(console, "info").mockImplementation(rec as any),
      jest.spyOn(console, "debug").mockImplementation(rec as any),
      jest.spyOn(Logger.prototype, "log").mockImplementation(rec as any),
      jest.spyOn(Logger.prototype, "warn").mockImplementation(rec as any),
      jest.spyOn(Logger.prototype, "error").mockImplementation(rec as any),
      jest.spyOn(Logger.prototype, "debug").mockImplementation(rec as any),
      jest.spyOn(Logger.prototype, "verbose").mockImplementation(rec as any),
    ];
    return { sinks, restore: () => spies.forEach((s) => s.mockRestore()) };
  }

  function forms(v: string): string[] {
    const b = Buffer.from(v);
    return [v, b.toString("base64"), b.toString("base64url"), b.toString("hex"), encodeURIComponent(v), ...Array.from({ length: v.length - 7 }, (_, i) => v.slice(i, i + 8))];
  }

  async function run(plain: { env: string; db: string; s3: string }) {
    const t = await make({ values: { "env:e1|value": { cls: "env", plain: plain.env }, "database:d1|postgres_password": { cls: "db_credentials", plain: plain.db }, "s3:s1|secret": { cls: "s3", plain: plain.s3 } } });
    const spies = spyAll();
    let result: Awaited<ReturnType<typeof t.svc2.fetchEncrypted>> | undefined;
    try {
      result = await t.svc2.fetchEncrypted({ serverId: "s1", refs: ["env:e1", "database:d1", "s3:s1"], userId: "u1" });
    } finally {
      spies.restore();
    }
    const surfaces: Record<string, string> = {
      "audit rows": JSON.stringify(t.audit.log.mock.calls),
      "grant table (prisma)": JSON.stringify(t.table.rows),
      "prisma writes": JSON.stringify([t.table.coolifyHostGrant.create.mock.calls, t.table.coolifyHostGrant.update.mock.calls]),
      "request frames to the agent": JSON.stringify(t.agentWs.sendCoolifySecrets.mock.calls),
      "console and Logger output": spies.sinks.join("\n"),
      "returned result minus ciphertext": JSON.stringify({ ...result, values: result!.values.map((v) => ({ ref: v.ref, field: v.field, cls: v.cls })) }),
      "stored ciphertext": JSON.stringify(result!.values.map((v) => v.enc)),
    };
    return { t, result: result!, surfaces };
  }

  it("the planted values appear only inside tk1 ciphertext, and decrypt back to the right values", async () => {
    const { t, result, surfaces } = await run(CANARIES);
    for (const [name, text] of Object.entries(surfaces)) {
      for (const [label, value] of Object.entries(CANARIES)) {
        for (const f of forms(value)) expect([name, label, text.includes(f)]).toEqual([name, label, false]);
      }
    }
    const byRef = Object.fromEntries(result.values.map((v) => [v.ref, t.crypto.decrypt(v.enc)]));
    expect(byRef).toEqual({ "env:e1": CANARIES.env, "database:d1": CANARIES.db, "s3:s1": CANARIES.s3 });
  });

  it("negative control: a deliberate leak of a value into any of those places IS caught by the same search", async () => {
    // The search itself is exercised: plant each canary in each surface in each form and make sure the scan above would flag it.
    const { surfaces } = await run(CANARIES);
    const v = CANARIES.env;
    for (const planted of forms(v).slice(0, 5)) {
      for (const name of Object.keys(surfaces)) {
        const leaked = surfaces[name] + " " + planted;
        expect([name, forms(v).some((f) => leaked.includes(f))]).toEqual([name, true]);
      }
    }
    // and a leaky sink (a console.log of the value) lands in the captured output
    const spies = spyAll();
    try {
      const t = await make({ values: { "env:e1|value": { cls: "env", plain: v } } });
      await t.svc2.fetch({ serverId: "s1", refs: ["env:e1"] }, (s) => console.log("leaky sink", s.value));
    } finally {
      spies.restore();
    }
    expect(spies.sinks.join("\n")).toContain(v);
  });

  it("the sink is the only place a plaintext exists: it is called once per value, in memory, with nothing persisted by the service", async () => {
    const t = await make({ values: { "env:e1|value": { cls: "env", plain: CANARIES.env } } });
    const calls: string[] = [];
    await t.svc2.fetch({ serverId: "s1", refs: ["env:e1"] }, (s) => void calls.push(s.value));
    expect(calls).toEqual([CANARIES.env]);
    expect(JSON.stringify(t.table.rows)).not.toContain(CANARIES.env);
    expect(JSON.stringify(t.audit.log.mock.calls)).not.toContain(CANARIES.env);
  });
});

describe("CoolifySecretsService: a read is bound to the run (the import session) it was consented for", () => {
  it("serves a read for the run of the standing grant, and refuses a read for another run before asking the agent", async () => {
    const h = await grantHarness({ sessions: { sess1: { id: "sess1", actorId: "u1", teamId: "t1", status: "active", expiresAt: new Date(Date.now() + 3_600_000), transport: "agent", agentServerId: "s1" } } });
    const agentWs = { sendCoolifySecrets: jest.fn(async () => []) } as any;
    const svc = new CoolifySecretsService(h.svc, h.sealed, agentWs, h.crypto, h.audit);
    await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });

    await expect(svc.fetchEncrypted({ serverId: "s1", refs: ["env:a"], userId: "u1", runId: "sess1" })).resolves.toMatchObject({ read: 0 });
    expect(agentWs.sendCoolifySecrets).toHaveBeenCalledTimes(1);

    await expect(svc.fetchEncrypted({ serverId: "s1", refs: ["env:a"], userId: "u1", runId: "sess-other" })).rejects.toMatchObject({ response: { code: "consent_other_run" } });
    expect(agentWs.sendCoolifySecrets).toHaveBeenCalledTimes(1); // the agent was not asked
  });

  it("a read without a run id keeps working for any standing grant (the ones that are not part of an import)", async () => {
    const t = await make();
    await expect(t.svc2.fetchEncrypted({ serverId: "s1", refs: ["env:a"], userId: "u1" })).resolves.toMatchObject({ read: 0 });
  });

  it("stops between two frames when the run's consent ends (finishRun by the run id)", async () => {
    const h = await grantHarness({ sessions: { sess1: { id: "sess1", actorId: "u1", teamId: "t1", status: "active", expiresAt: new Date(Date.now() + 3_600_000), transport: "agent", agentServerId: "s1" } } });
    const agentWs = {
      sendCoolifySecrets: jest.fn(async () => {
        await h.svc.finishRunByRunId("s1", "sess1");
        return [];
      }),
    } as any;
    const svc = new CoolifySecretsService(h.svc, h.sealed, agentWs, h.crypto, h.audit);
    await h.svc.createSecretsGrant("u1", { ...ok, importSessionId: "sess1" });
    const refs = Array.from({ length: 450 }, (_, i) => `env:r${i}`);
    const r = await svc.fetchEncrypted({ serverId: "s1", refs, userId: "u1", runId: "sess1" });
    expect(agentWs.sendCoolifySecrets).toHaveBeenCalledTimes(1);
    expect(r.incomplete?.code).toBe("no_active_grant");
    expect(r.incomplete?.remainingRefs).toHaveLength(250);
  });
});

