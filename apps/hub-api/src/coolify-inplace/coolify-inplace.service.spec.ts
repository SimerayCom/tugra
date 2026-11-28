import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { CoolifyInPlaceService } from "./coolify-inplace.service";
import { Box, H, PROXY_ID, type BoxApp, type BoxDb } from "./inplace-box";
import { PlanSchema } from "./dto";

const ACTOR = "u1";

const web: BoxApp = { appId: "appweb", itemRef: "app:s1:webuuid", name: "web", host: "web.example.com", ctrId: H("a"), ctrName: "webuuid-20261125T101010", image: "webuuid:aaa111" };
const data: BoxApp = {
  appId: "appdb",
  itemRef: "app:s1:dbuuid",
  name: "api",
  host: "api.example.com",
  ctrId: H("b"),
  ctrName: "dbuuid-20261125T101010",
  image: "dbuuid:bbb222",
  mounts: [{ type: "volume", source: "dbuuid-data", dest: "/data", rw: true }],
  volumes: [{ name: "data", path: "/data" }],
};

function build(o: { role?: Role | null; apps?: BoxApp[]; dbs?: BoxDb[] } = {}) {
  const box = new Box();
  for (const a of o.apps ?? [web, data]) box.add(a);
  for (const d of o.dbs ?? []) box.addDb(d);
  const rows = new Map<string, Record<string, unknown>>();
  let n = 0;
  const prisma = {
    coolifyTakeover: {
      create: jest.fn(async ({ data: d }: { data: Record<string, unknown> }) => {
        const id = `tk${(n += 1)}`;
        const r = { id, createdAt: new Date("2026-11-26T10:00:00Z"), finishedAt: null, failureCode: null, tempPort: null, sessionId: null, runId: null, ...d };
        rows.set(id, JSON.parse(JSON.stringify(r)));
        return { ...rows.get(id), createdAt: r.createdAt } as never;
      }),
      update: jest.fn(async ({ where, data: d }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = rows.get(where.id)!;
        Object.assign(r, JSON.parse(JSON.stringify(d)));
        if (d.finishedAt instanceof Date) r.finishedAt = d.finishedAt;
        return r;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = rows.get(where.id);
        return r ? { ...r, createdAt: new Date("2026-11-26T10:00:00Z"), finishedAt: r.finishedAt ? new Date(r.finishedAt as never) : null } : null;
      }),
      findFirst: jest.fn(async ({ where }: { where: { runId: string } }) => {
        const r = [...rows.values()].filter((x) => x.runId === where.runId).pop();
        return r ? { ...r, createdAt: new Date("2026-11-26T10:00:00Z"), finishedAt: r.finishedAt ? new Date(r.finishedAt as never) : null } : null;
      }),
      findMany: jest.fn(async (q?: { where?: { status?: string | { in: string[] }; giveBackAvailable?: boolean } }) =>
        [...rows.values()]
          .filter((r) => {
            const st = q?.where?.status;
            if (st !== undefined && !(typeof st === "string" ? r.status === st : st.in.includes(r.status as string))) return false;
            return q?.where?.giveBackAvailable === undefined || r.giveBackAvailable === q.where.giveBackAvailable;
          })
          .map((r) => ({ ...r, createdAt: new Date("2026-11-26T10:00:00Z"), finishedAt: null })),
      ),
      updateMany: jest.fn(async ({ where, data: d }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        const r = rows.get(where.id);
        if (!r || r.status !== where.status) return { count: 0 };
        Object.assign(r, d);
        return { count: 1 };
      }),
      deleteMany: jest.fn(async ({ where }: { where: { serverId: string; status: string; runId: null } }) => {
        const hit = [...rows.values()].filter((r) => r.serverId === where.serverId && r.status === where.status && (r.runId ?? null) === where.runId);
        for (const r of hit) rows.delete(r.id as string);
        return { count: hit.length };
      }),
    },
  };
  const access = { teamRole: jest.fn(async (..._a: unknown[]) => (o.role === undefined ? Role.OWNER : o.role)) };
  const audit = { log: jest.fn(async (..._a: unknown[]) => undefined) };
  const svc = new CoolifyInPlaceService(prisma as never, access as never, audit as never, box);
  return { svc, box, prisma, access, audit, rows };
}

const plan = (t: ReturnType<typeof build>, rebuild: string[] = []) => t.svc.plan(ACTOR, PlanSchema.parse({ serverId: "srv1", opId: "op1", rebuild }));
/** A takeover that carries a guided run ("run1"), swapped: the way CUTOVER of an in-place run drives it. */
const swapRun = async (t: ReturnType<typeof build>) => {
  await t.svc.runPrepare(ACTOR, { runId: "run1", serverId: "srv1", opId: "op1" });
  await t.svc.runSwap(ACTOR, "run1");
  return (await t.svc.runView(ACTOR, "run1")).id;
};
const swapOk = async (t: ReturnType<typeof build>) => {
  const p = await plan(t);
  await t.svc.test(ACTOR, p.id);
  return t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
};

describe("plan", () => {
  it("reads what Coolify runs and maps each app: the one without writable data runs alongside, the one with a volume is exclusive", async () => {
    const t = build();
    const v = await plan(t);
    expect(v.status).toBe("PLANNED");
    expect(v.giveBackAvailable).toBe(true);
    expect(v.tempPort).toBeNull();
    expect(v.items.map((i) => [i.itemRef, i.buildMode, i.exclusive ?? false, i.skipped ?? false])).toEqual([
      ["app:s1:webuuid", "reuse-image", false, false],
      ["app:s1:dbuuid", "reuse-image", true, false],
    ]);
    // plan only reads: no state-changing command reached the box
    expect(t.box.events).toEqual([]);
    expect(t.box.tugraProxy.state).toBe("absent");
  });
  it("planning again replaces a takeover that was only planned (nothing was changed), so the owner can change the rebuild choice; a tested one is never replaced", async () => {
    const t = build();
    const first = await plan(t);
    const second = await plan(t, ["app:s1:webuuid"]);
    expect(second.id).not.toBe(first.id);
    expect(t.rows.size).toBe(1);
    expect(second.items.find((i) => i.itemRef === "app:s1:webuuid")?.buildMode).toBe("rebuild-verify");
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.replan", meta: { replaced: 1 } }));
    await t.svc.test(ACTOR, second.id);
    // now the box has been touched: planning again never deletes that takeover (the live server stays held by it)
    await plan(t);
    expect(t.rows.has(second.id)).toBe(true);
  });
  it("is owner-only and a non-member cannot tell it exists", async () => {
    await expect(plan(build({ role: Role.ADMIN }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(plan(build({ role: null }))).rejects.toBeInstanceOf(NotFoundException);
  });
  it("refuses an offline agent, a missing deploy capability and a busy server", async () => {
    const a = build();
    a.box.status = "OFFLINE";
    await expect(plan(a)).rejects.toMatchObject({ response: { code: "takeover_server_offline" } });
    const b = build();
    b.box.capabilities = [];
    await expect(plan(b)).rejects.toMatchObject({ response: { code: "takeover_capability" } });
    const c = build();
    c.box.busy = true;
    await expect(plan(c)).rejects.toBeInstanceOf(ConflictException);
  });
  it("refuses the box the Coolify control plane runs on, and a proxy that is not running", async () => {
    const a = build();
    a.box.controlPlane = "ghcr.io/coollabsio/coolify:4.7.8";
    await expect(plan(a)).rejects.toMatchObject({ response: { code: "takeover_control_plane" } });
    const b = build();
    b.box.coolifyProxy.running = false;
    await expect(plan(b)).rejects.toMatchObject({ response: { code: "takeover_proxy_not_running" } });
  });
  it("refuses to start when Tugra's proxy already runs on a real bind (restarting it dark would drop the apps it serves), and when that cannot be told", async () => {
    const a = build();
    a.box.tugraProxy = { state: "running", published: false };
    a.box.bind = "loopback";
    await expect(plan(a)).rejects.toMatchObject({ response: { code: "takeover_tugra_proxy_in_use" } });
    const b = build();
    b.box.proxyStatus = async () => {
      throw new Error("agent timeout");
    };
    await expect(plan(b)).rejects.toMatchObject({ response: { code: "takeover_tugra_proxy_in_use" } });
    const c = build();
    c.box.tugraProxy = { state: "running", published: false };
    c.box.bind = "none"; // already dark: nothing to drop
    await expect(plan(c)).resolves.toMatchObject({ status: "PLANNED" });
    const d = build();
    d.box.tugraProxy = { state: "exited", published: false }; // stopped: nothing is served by it
    await expect(plan(d)).resolves.toMatchObject({ status: "PLANNED" });
  });
  it("an unknown op, an empty op and an unknown rebuild item are refused", async () => {
    const t = build();
    await expect(t.svc.plan(ACTOR, PlanSchema.parse({ serverId: "srv1", opId: "nope" }))).rejects.toBeInstanceOf(NotFoundException);
    await expect(plan(t, ["app:s1:ghost"])).rejects.toMatchObject({ response: { code: "takeover_unknown_item" } });
    await expect(t.svc.plan(ACTOR, PlanSchema.parse({ serverId: "ghost", opId: "op1" }))).rejects.toBeInstanceOf(NotFoundException);
  });
  it("keeps an app it cannot take over, skipped, with the reasons", async () => {
    const t = build({ apps: [web, { ...data, volumes: [] }, { ...web, appId: "appgone", itemRef: "app:s1:gone", ctrId: H("c"), ctrName: "gone-20261125T101010", host: "gone.example.com", image: "gone:1", ctrRunning: false }] });
    const v = await plan(t);
    const byRef = Object.fromEntries(v.items.map((i) => [i.itemRef, i]));
    expect(byRef["app:s1:dbuuid"]).toMatchObject({ skipped: true, issues: ["volume_unmapped"] });
    expect(byRef["app:s1:gone"]).toMatchObject({ skipped: true, issues: ["container_absent"] });
    expect(byRef["app:s1:webuuid"].skipped).toBeUndefined();
  });
  it("an app that shares writable data cannot be rebuilt next to Coolify's copy", async () => {
    await expect(plan(build(), ["app:s1:dbuuid"])).rejects.toMatchObject({ response: { code: "takeover_rebuild_needs_side_by_side" } });
  });
  it("the stored plan and the view carry names, counts and codes only", async () => {
    const t = build();
    const v = await plan(t);
    const stored = JSON.stringify([...t.rows.values()].map((r) => r.plan));
    expect(stored).not.toMatch(/token|secret|password|PRIVATE/i);
    expect(JSON.stringify(v)).not.toMatch(/sha256|tugra_app|[0-9a-f]{64}|"restart"|"image"/);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.plan", meta: expect.objectContaining({ apps: 2 }) }));
  });
});

describe("test", () => {
  it("adopts Coolify's image without a build, aliases the volume without a copy, starts Tugra's proxy with no published port and tests the app that can run alongside", async () => {
    const t = build();
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(v.status).toBe("TESTING");
    expect(v.failureCode).toBeNull();
    expect(t.box.tags).toEqual(new Set(["tugra_appweb:dep1", "tugra_appdb:dep2"]));
    expect(t.box.aliases.get("tugra_appv_appdb_data")).toBe("dbuuid-data");
    // the public ports still belong to Coolify's proxy
    expect(t.box.coolifyProxy.running).toBe(true);
    expect(t.box.tugraProxy).toEqual({ state: "running", published: false });
    expect(t.box.proxyBinds).toEqual(["none"]);
    // the app that runs alongside is up on Tugra's side and tested; the one sharing data is NOT started next to Coolify's copy
    expect(t.box.tugraRunning).toEqual(new Set(["appweb"]));
    const web = v.items[0];
    expect(web.domains[0]).toMatchObject({ host: "web.example.com", tempCheck: "ok", finalCheck: "pending", cert: "pending" });
    expect(v.items[1].domains[0].tempCheck).toBe("pending");
    expect(t.box.ctrs.get(H("b"))!.running).toBe(true);
  });
  it("a domain whose content differs through Tugra fails, and the swap is then refused", async () => {
    const t = build();
    t.box.differs.add("web.example.com");
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(v.items[0].domains[0].tempCheck).toBe("failed");
    await expect(t.svc.swap(ACTOR, p.id, { confirm: "edge-box" })).rejects.toMatchObject({ response: { code: "takeover_test_failed", host: "web.example.com" } });
    expect(t.box.coolifyProxy.running).toBe(true);
  });
  it("a page that changes on every request is judged by status only", async () => {
    const t = build();
    t.box.dynamic.add("web.example.com");
    const p = await plan(t);
    expect((await t.svc.test(ACTOR, p.id)).items[0].domains[0].tempCheck).toBe("ok");
  });
  it("an image that is not on the box leaves that app out, drops the deployment it made and never tags", async () => {
    const t = build();
    t.box.images.delete("webuuid:aaa111");
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(v.items[0]).toMatchObject({ skipped: true, issues: ["image_missing"] });
    expect(t.box.dropped).toEqual(["dep1"]);
    expect(t.box.tags.has("tugra_appweb:dep1")).toBe(false);
  });
  it("a Tugra volume that already exists and is not the alias leaves the app out", async () => {
    const t = build();
    t.box.aliases.set("tugra_appv_appdb_data", "some-other-volume");
    const p = await plan(t);
    expect((await t.svc.test(ACTOR, p.id)).items[1]).toMatchObject({ skipped: true, issues: ["volume_alias_foreign"] });
  });
  it("an app Tugra could not start is left out with its reason", async () => {
    const t = build();
    t.box.failAdopted.add("appweb");
    const p = await plan(t);
    expect((await t.svc.test(ACTOR, p.id)).items[0]).toMatchObject({ skipped: true, issues: ["prepare_failed"] });
  });
  it("no curl on the box is a failure code, not a pass", async () => {
    const t = build();
    t.box.noCurl = true;
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(v.failureCode).toBe("probe_unavailable");
    expect(v.items[0].domains[0].tempCheck).toBe("pending");
  });
  it("can be pressed again and does not repeat what is done", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    await t.svc.test(ACTOR, p.id);
    expect(t.box.events.filter((e) => e.startsWith("tag:")).length).toBe(2);
    expect(t.box.proxyBinds).toEqual(["none"]);
  });
  it("only one action runs at a time per takeover", async () => {
    const t = build();
    const p = await plan(t);
    const slow = t.svc.test(ACTOR, p.id);
    await expect(t.svc.test(ACTOR, p.id)).rejects.toMatchObject({ response: expect.anything() });
    await slow;
  });
  it("an app built with Tugra (the owner's choice) is started by a normal deploy and read back on the next test", async () => {
    const t = build({ apps: [web] });
    const p = await plan(t, ["app:s1:webuuid"]);
    const v1 = await t.svc.test(ACTOR, p.id);
    expect(v1.items[0].buildMode).toBe("rebuild-verify");
    expect(v1.items[0].domains[0].tempCheck).toBe("pending");
    expect(t.box.tags.size).toBe(0); // no image adopted
    t.box.deployStates.set("build1", "SUCCESS");
    t.box.tugraRunning.add("appweb");
    const v2 = await t.svc.test(ACTOR, p.id);
    expect(v2.items[0].domains[0].tempCheck).toBe("ok");
  });
  it("a failed rebuild leaves the app out", async () => {
    const t = build({ apps: [web] });
    const p = await plan(t, ["app:s1:webuuid"]);
    await t.svc.test(ACTOR, p.id);
    t.box.deployStates.set("build1", "FAILED");
    expect((await t.svc.test(ACTOR, p.id)).items[0]).toMatchObject({ skipped: true, issues: ["rebuild_failed"] });
  });
});

describe("swap", () => {
  it("needs a passed test, the typed server name and the owner", async () => {
    const t = build();
    const p = await plan(t);
    await expect(t.svc.swap(ACTOR, p.id, { confirm: "edge-box" })).rejects.toMatchObject({ response: expect.objectContaining({ message: "takeover_not_tested" }) });
    await t.svc.test(ACTOR, p.id);
    await expect(t.svc.swap(ACTOR, p.id, { confirm: "wrong" })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.box.coolifyProxy.running).toBe(true);
    const lesser = build({ role: Role.ADMIN });
    await expect(lesser.svc.swap(ACTOR, "tk1", { confirm: "x" })).rejects.toBeInstanceOf(NotFoundException);
  });
  it("takes the ports in order: Coolify's data owner stops before Tugra's starts, certificates are in place before the proxies change, Coolify's proxy stops before Tugra's publishes", async () => {
    const t = build();
    const v = await swapOk(t);
    expect(v.status).toBe("SWAPPED");
    const ev = t.box.events;
    const at = (e: string) => ev.indexOf(e);
    expect(at("policy:no")).toBeLessThan(at("coolify-ctr:stop:dbuuid-20261125T101010"));
    expect(at("coolify-ctr:stop:dbuuid-20261125T101010")).toBeLessThan(at("tugra-app:start:appdb"));
    expect(at("tugra-app:start:appdb")).toBeLessThan(at("fallback:install:api.example.com"));
    expect(at("fallback:install:web.example.com")).toBeLessThan(at("coolify-proxy:stop"));
    expect(at("coolify-proxy:stop")).toBeLessThan(at("bind:public"));
    expect(at("bind:public")).toBeLessThan(ev.lastIndexOf("proxy:start:public"));
    expect(t.box.coolifyProxy).toEqual({ running: false, restart: "no" });
    expect(t.box.tugraProxy).toEqual({ state: "running", published: true });
    // the side-by-side app's Coolify container is left running; only the one sharing data was stopped
    expect(t.box.ctrs.get(H("a"))!.running).toBe(true);
    expect(t.box.ctrs.get(H("b"))!.running).toBe(false);
    // every domain was checked again through the proxy that now owns the box, and Coolify's certificate stands in until a new one is verified
    expect(v.items.flatMap((i) => i.domains).map((d) => [d.finalCheck, d.cert])).toEqual([["ok", "fallback"], ["ok", "fallback"]]);
  });
  it("two containers are never running on the same writable data", async () => {
    const t = build();
    await swapOk(t); // the fake throws if Tugra's copy starts while Coolify's still runs; reaching here proves the order
    expect(t.box.tugraRunning).toEqual(new Set(["appweb", "appdb"]));
  });
  it("a domain that fails after the swap is shown as failed and the takeover stays swapped for the owner to decide", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.differs.add("api.example.com"); // the exclusive app answers differently once Tugra serves it
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("SWAPPED");
    expect(v.items[1].domains[0].finalCheck).toBe("failed");
    expect(v.giveBackAvailable).toBe(true);
  });
  it("a Coolify proxy that will not stop reverses the switch by itself and ends FAILED with the reason", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.failProxyStop = true;
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("swap_stop_failed");
    expect(t.box.ctrs.get(H("b"))!.running).toBe(true); // Coolify's container is back
    expect(t.box.ctrs.get(H("b"))!.restart).toBe("unless-stopped"); // with its recorded restart policy
    expect(t.box.coolifyProxy.running).toBe(true);
    expect(t.box.tugraRunning.has("appdb")).toBe(false);
  });
  it("Tugra's proxy failing to take the ports puts Coolify's proxy back", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    const orig = t.box.startProxy.bind(t.box);
    t.box.startProxy = async () => {
      if (t.box.bind === "public") throw new Error("boom");
      return orig();
    };
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("swap_start_failed");
    expect(t.box.coolifyProxy).toEqual({ running: true, restart: "unless-stopped" });
    expect(t.box.ctrs.get(H("b"))!.running).toBe(true);
  });
  it("a Coolify container that will not stop aborts before anything else is touched", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.failStopCtr.add(H("b"));
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.failureCode).toBe("exclusive_stop_failed");
    expect(t.box.coolifyProxy.running).toBe(true);
    expect(t.box.tugraProxy.published).toBe(false);
  });
  it("a restart-policy change that fails for some containers still gives every recorded policy back", async () => {
    const data2: BoxApp = { ...data, appId: "appdb2", itemRef: "app:s1:db2uuid", name: "api2", host: "api2.example.com", ctrId: H("d"), ctrName: "db2uuid-20261125T101010", image: "db2uuid:ddd444", mounts: [{ type: "volume", source: "db2uuid-data", dest: "/data", rw: true }] };
    const t = build({ apps: [web, data, data2] });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.failPolicyNo.add(H("d"));
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("exclusive_policy_failed");
    // the first container did get policy "no" before the failure: it has its recorded policy back, and both still run
    for (const id of [H("b"), H("d")]) {
      expect(t.box.ctrs.get(id)!.restart).toBe("unless-stopped");
      expect(t.box.ctrs.get(id)!.running).toBe(true);
    }
    expect(t.box.coolifyProxy.running).toBe(true);
    expect(t.box.tugraProxy.published).toBe(false);
  });
  it("audits the swap with counts only", async () => {
    const t = build();
    await swapOk(t);
    const call = t.audit.log.mock.calls.map((c) => c[0] as { action: string; meta: Record<string, unknown> }).find((c) => c.action === "coolify.takeover.swap")!;
    expect(call.meta).toMatchObject({ apps: 2, switched: 1, domains: 2, fallbacks: 2 });
    expect(JSON.stringify(call)).not.toMatch(/example\.com|webuuid|[0-9a-f]{64}/);
  });
});

describe("verify: new certificates", () => {
  it("replaces the fallback with a new Let's Encrypt certificate per domain, then the takeover is VERIFIED", async () => {
    const t = build();
    const p = await swapOk(t);
    const v = await t.svc.verify(ACTOR, p.id);
    expect(v.status).toBe("VERIFIED");
    expect(v.items.flatMap((i) => i.domains).map((d) => d.cert)).toEqual(["issued", "issued"]);
    expect(t.box.fallback.size).toBe(0);
    expect(t.box.leIssued).toEqual(new Set(["web.example.com", "api.example.com"]));
  });
  it("when no new certificate comes, Coolify's goes back, the domain is failed, and it is tried again later", async () => {
    const t = build({ apps: [web] });
    t.box.leWorks = false;
    const p = await swapOk(t);
    const v1 = await t.svc.verify(ACTOR, p.id);
    expect(v1.status).toBe("SWAPPED");
    expect(v1.items[0].domains[0].cert).toBe("failed");
    expect(t.box.fallback.has("web.example.com")).toBe(true); // the domain keeps a valid certificate
    expect(t.box.sleeps).toBeGreaterThan(0);
    t.box.leWorks = true;
    const v2 = await t.svc.verify(ACTOR, p.id);
    expect(v2.status).toBe("VERIFIED");
  });
  it("stops retrying a domain after the attempts are used and never marks it done (the timer and the run's polls never give new attempts)", async () => {
    const t = build({ apps: [web] });
    t.box.leWorks = false;
    const id = await swapRun(t);
    for (let i = 0; i < 5; i++) await t.svc.runVerify(ACTOR, "run1");
    const view = await t.svc.get(ACTOR, id);
    expect(view.status).toBe("SWAPPED");
    expect(view.items[0].domains[0].cert).toBe("failed");
    const removes = t.box.events.filter((e) => e === "fallback:remove:web.example.com").length;
    expect(removes).toBe(3);
  });
  it("after the owner fixed the cause, a manual check tries again (new attempts) and the new certificate is recognised", async () => {
    const t = build({ apps: [web] });
    t.box.leWorks = false;
    const id = await swapRun(t);
    for (let i = 0; i < 4; i++) await t.svc.runVerify(ACTOR, "run1");
    expect((await t.svc.runVerify(ACTOR, "run1")).certWorkLeft).toBe(false); // used up: nothing more on its own
    expect((await t.svc.get(ACTOR, id)).items[0].domains[0].cert).toBe("failed");
    t.box.leWorks = true;
    const v = await t.svc.verify(ACTOR, id);
    expect(v.status).toBe("VERIFIED");
    expect(v.items[0].domains[0].cert).toBe("issued");
  });
  it("a retry of the run's step gives new attempts too, a plain poll does not", async () => {
    const t = build({ apps: [web] });
    t.box.leWorks = false;
    await swapRun(t);
    for (let i = 0; i < 4; i++) await t.svc.runVerify(ACTOR, "run1");
    t.box.leWorks = true;
    expect((await t.svc.runVerify(ACTOR, "run1")).verified).toBe(false);
    expect((await t.svc.runVerify(ACTOR, "run1", { retry: true })).verified).toBe(true);
  });
  it("a certificate the proxy obtained on its own after the attempts were used is recognised by the timer, without taking anything away", async () => {
    const t = build({ apps: [web] });
    t.box.leWorks = false;
    const id = await swapRun(t);
    for (let i = 0; i < 4; i++) await t.svc.runVerify(ACTOR, "run1");
    expect(t.box.events.filter((e) => e === "fallback:remove:web.example.com").length).toBe(3);
    t.box.leIssued.add("web.example.com"); // the proxy got one by itself
    expect(await t.svc.sweepFallbacks()).toBe(1);
    const v = await t.svc.get(ACTOR, id);
    expect(v.status).toBe("VERIFIED");
    expect(v.items[0].domains[0].cert).toBe("issued");
    expect(t.box.events.filter((e) => e === "fallback:remove:web.example.com").length).toBe(4); // only the one that goes once the new certificate stands
  });
  it("a certificate that arrives late is recognised by the timer even when the takeover already shows a failure (fallback_overdue)", async () => {
    const t = build({ apps: [web] });
    t.box.leWorks = false;
    const id = await swapRun(t);
    for (let i = 0; i < 4; i++) await t.svc.runVerify(ACTOR, "run1"); // attempts used
    t.box.clock = new Date(t.box.clock.getTime() + 11 * 60_000);
    await t.svc.sweepFallbacks();
    const stuck = await t.svc.get(ACTOR, id);
    expect(stuck.status).toBe("SWAPPED");
    expect(stuck.failureCode).toBe("fallback_overdue");
    t.box.leIssued.add("web.example.com"); // the proxy got one by itself, late
    expect(await t.svc.sweepFallbacks()).toBe(1);
    const v = await t.svc.get(ACTOR, id);
    expect(v.status).toBe("VERIFIED");
    expect(v.failureCode ?? null).toBeNull();
    expect(v.items[0].domains[0].cert).toBe("issued");
  });
  it("handles a few domains per call", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...web, appId: `app${i}`, itemRef: `app:s1:u${i}`, host: `h${i}.example.com`, ctrId: H(String(i)), ctrName: `u${i}-20261125T101010`, image: `u${i}:1` }));
    const t = build({ apps: many });
    const p = await swapOk(t);
    const v = await t.svc.verify(ACTOR, p.id);
    const issued = v.items.flatMap((i) => i.domains).filter((d) => d.cert === "issued").length;
    expect(issued).toBe(5);
    expect(v.status).toBe("SWAPPED");
    expect((await t.svc.verify(ACTOR, p.id)).status).toBe("VERIFIED");
  });
  it("the hub works on the certificates by itself after the swap, as the owner who planned it, and audits it as automatic", async () => {
    const t = build();
    const p = await swapOk(t);
    expect(await t.svc.sweepFallbacks()).toBe(1);
    const v = await t.svc.get(ACTOR, p.id);
    expect(v.status).toBe("VERIFIED");
    expect(t.box.fallback.size).toBe(0);
    const call = t.audit.log.mock.calls.map((c) => c[0] as { actor: string; action: string; meta: Record<string, unknown> }).filter((c) => c.action === "coolify.takeover.verify");
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({ actor: ACTOR, meta: expect.objectContaining({ auto: true, issued: 2 }) });
    // nothing left to do: the next tick leaves it alone
    expect(await t.svc.sweepFallbacks()).toBe(0);
  });
  it("the timer only touches swapped takeovers and never one whose planner is no longer an owner", async () => {
    const t = build();
    await plan(t); // PLANNED: not swept
    expect(await t.svc.sweepFallbacks()).toBe(0);
    expect(t.box.events).toEqual([]);
    const u = build();
    await swapOk(u);
    u.access.teamRole.mockResolvedValue(Role.ADMIN);
    const before = u.box.scripts.length;
    expect(await u.svc.sweepFallbacks()).toBe(0);
    expect(u.box.scripts).toHaveLength(before);
  });
  it("Coolify's certificate served past the limit is a visible failure, kept while the box keeps a valid certificate", async () => {
    const t = build({ apps: [web] });
    t.box.leWorks = false;
    const p = await swapOk(t);
    await t.svc.sweepFallbacks();
    expect((await t.svc.get(ACTOR, p.id)).failureCode ?? null).toBeNull(); // still inside the window
    t.box.clock = new Date(t.box.clock.getTime() + 11 * 60_000);
    await t.svc.sweepFallbacks();
    const v = await t.svc.get(ACTOR, p.id);
    expect(v.status).toBe("SWAPPED");
    expect(v.failureCode).toBe("fallback_overdue");
    expect(t.box.fallback.has("web.example.com")).toBe(true);
    // attempts are used and the failure is shown: the timer makes no further attempt (it only looks whether a certificate came by itself)
    for (let i = 0; i < 4; i++) await t.svc.sweepFallbacks();
    expect(t.box.events.filter((e) => e === "fallback:remove:web.example.com").length).toBeLessThanOrEqual(3);
    const rows = t.audit.log.mock.calls.filter((c) => (c[0] as { action: string }).action === "coolify.takeover.verify").length;
    await t.svc.sweepFallbacks();
    expect(t.audit.log.mock.calls.filter((c) => (c[0] as { action: string }).action === "coolify.takeover.verify").length).toBe(rows);
    expect(t.audit.log.mock.calls.some((c) => (c[0] as { meta?: { failure?: string } }).meta?.failure === "fallback_overdue")).toBe(true);
  });
  it("a box without openssl is a failed check that stays visible, not a silent stop", async () => {
    const t = build({ apps: [web] });
    t.box.noOpenssl = true;
    const p = await swapOk(t);
    const v = await t.svc.verify(ACTOR, p.id);
    expect(v.status).toBe("SWAPPED");
    expect(v.failureCode).toBe("cert_check_unavailable");
    expect(v.items[0].domains[0].cert).toBe("failed");
    expect(t.box.fallback.has("web.example.com")).toBe(true);
    // sticky across later passes, and the timer leaves it alone
    expect((await t.svc.verify(ACTOR, p.id)).failureCode).toBe("cert_check_unavailable");
    expect(await t.svc.sweepFallbacks()).toBe(0);
  });
  it("is refused before the swap", async () => {
    const t = build();
    const p = await plan(t);
    await expect(t.svc.verify(ACTOR, p.id)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("give back", () => {
  it("one step puts Coolify back as it was found: containers with their policy, the proxy with its policy, Tugra's copies stopped, fallback gone, bind restored", async () => {
    const t = build();
    const p = await swapOk(t);
    const v = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("GIVEN_BACK");
    expect(v.giveBackAvailable).toBe(false);
    expect(v.finishedAt).not.toBeNull();
    expect(t.box.coolifyProxy).toEqual({ running: true, restart: "unless-stopped" });
    expect(t.box.ctrs.get(H("b"))).toMatchObject({ running: true, restart: "unless-stopped" });
    expect(t.box.ctrs.get(H("a"))!.running).toBe(true);
    expect(t.box.tugraRunning.size).toBe(0);
    expect(t.box.tugraProxy.published).toBe(false);
    expect(t.box.fallback.size).toBe(0);
    expect(t.box.bind).toBe("public"); // what it was before
    expect(v.items.flatMap((i) => i.domains).map((d) => [d.finalCheck, d.cert])).toEqual([["pending", "pending"], ["pending", "pending"]]);
  });
  it("Coolify's exclusive container starts again BEFORE the proxy goes back and Tugra's copy stops before it starts (never two on one data)", async () => {
    const t = build();
    const p = await swapOk(t);
    t.box.events.length = 0;
    await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    const at = (e: string) => t.box.events.indexOf(e);
    expect(at("tugra-app:stop:appdb")).toBeLessThan(at("coolify-ctr:start:dbuuid-20261125T101010"));
    expect(at("coolify-ctr:start:dbuuid-20261125T101010")).toBeLessThan(at("proxy:reverse"));
  });
  it("works from a takeover that was only tested: Coolify's proxy is never touched and Tugra's dark proxy is stopped", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    const v = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("GIVEN_BACK");
    expect(t.box.events).not.toContain("coolify-proxy:stop");
    expect(t.box.events).not.toContain("proxy:reverse");
    expect(t.box.tugraProxy.state).toBe("exited");
    expect(t.box.tugraRunning.size).toBe(0);
    expect(t.box.coolifyProxy.running).toBe(true);
  });
  it("works from a takeover that was only planned: nothing on the box changes", async () => {
    const t = build();
    const p = await plan(t);
    const v = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("GIVEN_BACK");
    expect(t.box.events.filter((e) => !e.startsWith("probe"))).toEqual([]);
  });
  it("needs the typed server name and the owner, and cannot be repeated once given back", async () => {
    const t = build();
    const p = await swapOk(t);
    await expect(t.svc.giveBack(ACTOR, p.id, { confirm: "nope" })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.box.coolifyProxy.running).toBe(false);
    await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    await expect(t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" })).rejects.toBeInstanceOf(ConflictException);
  });
  it("a step that fails ends FAILED and pressing it again finishes the job", async () => {
    const t = build();
    const p = await swapOk(t);
    t.box.coolifyProxy.running = false;
    const orig = t.box.exec.bind(t.box);
    let fail = true;
    t.box.exec = async (s: string, script: string) => {
      if (fail && script.includes('docker start "$ID"')) {
        const r = await orig(s, script);
        return { exitCode: 0, output: r.output.replace("TUGRA_SWAP_SOURCE_RUNNING=true", "TUGRA_SWAP_SOURCE_RUNNING=false") };
      }
      return orig(s, script);
    };
    const v1 = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v1.status).toBe("FAILED");
    expect(v1.failureCode).toBe("give_back_failed");
    fail = false;
    const v2 = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v2.status).toBe("GIVEN_BACK");
    expect(t.box.ctrs.get(H("b"))!.running).toBe(true);
    expect(t.box.coolifyProxy.running).toBe(true);
  });
  it("audits the give-back", async () => {
    const t = build();
    const p = await swapOk(t);
    await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.give-back", meta: expect.objectContaining({ ok: true }) }));
  });
});

describe("safety across the whole flow", () => {
  it("no script ever removes, kills, prunes or deletes anything, and none asks for an environment or a key", async () => {
    const t = build();
    const p = await swapOk(t);
    await t.svc.verify(ACTOR, p.id);
    await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(t.box.scripts.length).toBeGreaterThan(10);
    for (const s of t.box.scripts) {
      expect(s).not.toMatch(/docker\s+(rm|kill|prune|rmi|system)\b/);
      expect(s).not.toMatch(/volume\s+(rm|prune)|image\s+(rm|prune)/);
      expect(s).not.toMatch(/\.Config\.Env|printenv|docker\s+exec/);
    }
  });
  it("the Coolify proxy is only ever addressed by the id recorded at plan time", async () => {
    const t = build();
    await swapOk(t);
    const stops = t.box.scripts.filter((s) => s.includes('docker update --restart=no "$ID"'));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain(`ID='${PROXY_ID}'`);
  });
  it("a non-member can read nothing about a takeover", async () => {
    const t = build();
    const p = await plan(t);
    (t.access.teamRole as jest.Mock).mockResolvedValue(null);
    await expect(t.svc.get(ACTOR, p.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.svc.test(ACTOR, p.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" })).rejects.toBeInstanceOf(NotFoundException);
  });
  it("a swap run cannot be tested again once the ports are Tugra's", async () => {
    const t = build();
    const p = await swapOk(t);
    await expect(t.svc.test(ACTOR, p.id)).rejects.toBeInstanceOf(ConflictException);
  });
  it("the DTO refuses unknown fields and a bad item ref", () => {
    expect(() => PlanSchema.parse({ serverId: "s", opId: "o", extra: 1 })).toThrow();
    expect(() => PlanSchema.parse({ serverId: "s", opId: "o", rebuild: ["database:x:y"] })).toThrow();
  });
});

// ───────────────────────────── databases ─────────────────────────────

const pg: BoxDb = { dbId: "db1", itemRef: "database:s1:pguuid", name: "main", engine: "POSTGRES", ctrId: H("c"), ctrName: "pguuid", image: "postgres:16-alpine", rows: 42 };
const withDb = (o: { apps?: BoxApp[]; db?: Partial<BoxDb> } = {}) => build({ apps: o.apps ?? [web], dbs: [{ ...pg, ...o.db }] });
const dbItem = (v: { items: Array<{ itemRef: string; kind?: string }> }) => v.items.find((i) => i.itemRef === pg.itemRef) as { itemRef: string; kind?: string; skipped?: boolean; exclusive?: boolean; issues?: string[]; verify?: { level: string; state: string } };

describe("databases in the takeover", () => {
  it("plan maps a database to the container Coolify runs for it: always switched, never tested alongside, checked by row counts for postgres", async () => {
    const t = withDb();
    const v = await plan(t);
    expect(dbItem(v)).toMatchObject({ kind: "database", exclusive: true, verify: { level: "counts", state: "pending" } });
    expect(dbItem(v).skipped).toBeUndefined();
    expect(t.box.events).toEqual([]); // reading changed nothing
  });
  it("an app that talks to a taken-over database starts after it at the switch; one that does not is tested alongside as before", async () => {
    const t = withDb({ apps: [web, { ...data, appId: "appother", itemRef: "app:s1:otheruuid", host: "other.example.com", ctrId: H("d"), ctrName: "otheruuid-20261125T101010", image: "otheruuid:ccc", mounts: undefined }] });
    t.box.mentions.add("appweb");
    const v = await plan(t);
    expect(v.items.find((i) => i.itemRef === web.itemRef)).toMatchObject({ afterSwitch: true });
    expect(v.items.find((i) => i.itemRef === "app:s1:otheruuid")?.afterSwitch).toBeUndefined();
  });
  it("an environment that cannot be read counts as talking to the database (never silently tested alongside)", async () => {
    const t = withDb();
    t.box.mentionsUnreadable.add("appweb");
    expect((await plan(t)).items.find((i) => i.itemRef === web.itemRef)).toMatchObject({ afterSwitch: true });
  });
  it("keeps a database it cannot take over, with the reason: another image, an engine nobody could check, a data volume Tugra does not declare, no container", async () => {
    const cases: Array<[Partial<BoxDb>, string]> = [
      [{ tugraImage: "postgres:17" }, "db_image_differs"],
      [{ engine: "CLICKHOUSE" }, "db_engine_unsupported"],
      [{ dataMount: "/somewhere/else", mounts: [{ type: "volume", source: "pguuid-data", dest: "/var/lib/postgresql/data", rw: true }] }, "db_volume_unmapped"],
      [{ mounts: [{ type: "bind", source: "/srv/pg", dest: "/var/lib/postgresql/data", rw: true }] }, "db_volume_unmapped"],
    ];
    for (const [db, issue] of cases) {
      const v = await plan(withDb({ db }));
      expect(dbItem(v)).toMatchObject({ skipped: true, issues: [issue] });
    }
    const gone = withDb();
    gone.box.ctrs.get(pg.ctrId)!.running = false;
    expect(dbItem(await plan(gone))).toMatchObject({ skipped: true, issues: ["container_absent"] });
  });
  it("the image is compared the way docker spells it: the default registry and the implicit latest are the same image", async () => {
    expect(dbItem(await plan(withDb({ db: { image: "redis", tugraImage: "docker.io/library/redis:latest", engine: "REDIS", dataMount: "/data", itemRef: pg.itemRef } })))).not.toMatchObject({ skipped: true });
  });
  it("test aliases the volume to the Tugra database's own (no copy), reads what Coolify shows as the yardstick and starts nothing of Tugra's database", async () => {
    const t = withDb();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    expect(t.box.aliases.get("tugra_dbv_db1")).toBe("pguuid-data");
    expect(t.box.tugraDbRunning.size).toBe(0);
    expect(t.box.ctrs.get(pg.ctrId)!.running).toBe(true);
    expect(t.rows.get(p.id)!.items as unknown[]).toBeDefined();
    const stored = (t.rows.get(p.id)!.items as Array<{ itemRef: string; state: string; dbBefore?: { rows: number } }>).find((i) => i.itemRef === pg.itemRef)!;
    expect(stored).toMatchObject({ state: "prepared", dbBefore: { rows: 42 } });
  });
  it("a database whose rows cannot be read the way its engine is checked stays out: a switch nobody could verify would be a guess", async () => {
    const t = withDb();
    t.box.dbReadFails.add("db1");
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(dbItem(v)).toMatchObject({ skipped: true, issues: ["db_verify_failed"] });
  });
  it("the swap stops Coolify's containers first, starts Tugra's database on the same data, checks it against the yardstick, and only then starts the apps that depend on it", async () => {
    const t = withDb();
    t.box.mentions.add("appweb");
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    expect(t.box.tugraRunning.has("appweb")).toBe(false); // not started before the switch
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("SWAPPED");
    const at = (e: string) => t.box.events.indexOf(e);
    expect(at("coolify-ctr:stop:pguuid")).toBeGreaterThan(-1);
    expect(at("coolify-ctr:stop:pguuid")).toBeLessThan(at("tugra-db:start:db1"));
    expect(t.box.events.lastIndexOf("dbfp")).toBeGreaterThan(at("tugra-db:start:db1"));
    expect(at("tugra-db:start:db1")).toBeLessThan(at("tugra-app:start:appweb"));
    expect(t.box.tugraRunning.has("appweb")).toBe(true);
    expect(dbItem(v).verify).toEqual({ level: "counts", state: "ok" });
  });
  it("a database that was written to between the test and the swap still passes: the yardstick is read again at the swap, not at the test", async () => {
    const t = withDb();
    t.box.mentions.add("appweb");
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.dbs[0].rows = 57; // the apps kept writing while the owner took time to approve
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("SWAPPED");
    expect(dbItem(v).verify).toEqual({ level: "counts", state: "ok" });
    const stored = (t.rows.get(p.id)!.items as Array<{ itemRef: string; dbBefore?: { rows: number } }>).find((i) => i.itemRef === pg.itemRef)!;
    expect(stored.dbBefore?.rows).toBe(57);
  });
  it("the apps that talk to the database go quiet, then the yardstick is read, then the database stops", async () => {
    const t = withDb();
    t.box.mentions.add("appweb");
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.events.length = 0;
    await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    const at = (e: string) => t.box.events.indexOf(e);
    expect(at("coolify-ctr:stop:webuuid-20261125T101010")).toBeGreaterThan(-1);
    expect(at("coolify-ctr:stop:webuuid-20261125T101010")).toBeLessThan(at("dbfp"));
    expect(at("dbfp")).toBeLessThan(at("coolify-ctr:stop:pguuid"));
  });
  it("a baseline that cannot be read at the swap ends FAILED, and the quiet apps and the database run on Coolify again", async () => {
    const t = withDb();
    t.box.mentions.add("appweb");
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.dbReadFails.add("db1");
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("database_verify_failed");
    expect(t.box.ctrs.get(pg.ctrId)!.running).toBe(true);
    expect(t.box.ctrs.get(web.ctrId)!.running).toBe(true);
    expect(t.box.tugraDbRunning.size).toBe(0);
    expect(t.box.events).not.toContain("coolify-ctr:stop:pguuid");
  });
  it("the takeover is verified only when the database was checked too, besides every domain's certificate", async () => {
    const t = withDb();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    const v = await t.svc.verify(ACTOR, p.id);
    expect(v.status).toBe("VERIFIED");
    // a database that did not pass keeps it from being verified even when the domains are fine
    (t.rows.get(p.id)!.items as Array<{ itemRef: string; verify: { state: string } }>).find((i) => i.itemRef === pg.itemRef)!.verify.state = "failed";
    expect((await t.svc.verify(ACTOR, p.id)).status).toBe("SWAPPED");
  });
  it("a database that will not start on its data puts everything back: Coolify's containers run again, Tugra's database is stopped, FAILED with the reason", async () => {
    const t = withDb();
    t.box.failDbStart.add("db1");
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("database_start_failed");
    expect(t.box.ctrs.get(pg.ctrId)!.running).toBe(true);
    expect(t.box.tugraDbRunning.size).toBe(0);
    expect(t.box.coolifyProxy.running).toBe(true);
    expect(t.box.tugraProxy.published).toBe(false);
  });
  it("a database that looks different after the switch is put back with its rows untouched: nothing is deleted, the verdict says failed", async () => {
    const t = withDb();
    t.box.dbDiffers.add("db1");
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("database_verify_failed");
    expect(dbItem(v).verify).toEqual({ level: "counts", state: "failed" });
    expect(t.box.ctrs.get(pg.ctrId)!.running).toBe(true);
    expect(t.box.tugraDbRunning.size).toBe(0);
    expect(t.box.scripts.some((s) => /docker\s+(rm|rmi|volume rm|system prune)\b/.test(s))).toBe(false);
  });
  it("give back restores Coolify's database container with its recorded restart policy and stops Tugra's", async () => {
    const t = withDb({ db: { restart: "always" } });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(t.box.ctrs.get(pg.ctrId)).toMatchObject({ running: false, restart: "no" });
    const v = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("GIVEN_BACK");
    expect(t.box.ctrs.get(pg.ctrId)).toMatchObject({ running: true, restart: "always" });
    expect(t.box.tugraDbRunning.size).toBe(0);
    expect(t.box.events.indexOf("tugra-db:stop:db1")).toBeLessThan(t.box.events.lastIndexOf("coolify-ctr:start:pguuid"));
  });
  it("Tugra's database stopping is proven before Coolify's container starts: a stop that cannot be proven leaves the give-back FAILED and Coolify's container stopped", async () => {
    const t = withDb();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    t.box.stopDatabase = async () => {
      throw new Error("database still running");
    };
    const v = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("give_back_failed");
    expect(t.box.ctrs.get(pg.ctrId)!.running).toBe(false); // never two containers on one data directory
  });
  it("the swap gate counts the database as prepared and an after-switch app as not needing a test", async () => {
    const t = withDb();
    t.box.mentions.add("appweb");
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(v.failureCode).toBeNull();
    const web1 = v.items.find((i) => i.itemRef === web.itemRef)!;
    expect(web1.domains[0].tempCheck).toBe("pending"); // never tested alongside
    await expect(t.svc.swap(ACTOR, p.id, { confirm: "edge-box" })).resolves.toMatchObject({ status: "SWAPPED" });
  });
});


describe("a guided run's rebuild choice", () => {
  const prepare = (t: ReturnType<typeof build>, rebuild?: string[]) => t.svc.runPrepare(ACTOR, { runId: "run1", serverId: "srv1", opId: "op1", ...(rebuild ? { rebuild } : {}) });

  it("the run's list decides which apps are built with Tugra and verified; the rest reuse Coolify's image", async () => {
    const t = build();
    const st = await prepare(t, ["app:s1:webuuid"]);
    expect(st.items.map((i) => [i.itemRef, i.buildMode])).toEqual([
      ["app:s1:webuuid", "rebuild-verify"],
      ["app:s1:dbuuid", "reuse-image"],
    ]);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.plan", meta: expect.objectContaining({ runId: "run1", rebuild: 1 }) }));
  });
  it("no list (the default) builds nothing", async () => {
    const t = build();
    const st = await prepare(t);
    expect(st.items.every((i) => i.buildMode === "reuse-image")).toBe(true);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.plan", meta: expect.objectContaining({ rebuild: 0 }) }));
  });
  it("an app that shares writable data keeps Coolify's image in a run, marked, instead of failing the run; the standalone takeover still refuses it", async () => {
    const t = build();
    const st = await prepare(t, ["app:s1:dbuuid", "app:s1:webuuid"]);
    const byRef = Object.fromEntries(st.items.map((i) => [i.itemRef, i]));
    expect(byRef["app:s1:dbuuid"]).toMatchObject({ buildMode: "reuse-image", exclusive: true, rebuildDeclined: true });
    expect(byRef["app:s1:webuuid"].buildMode).toBe("rebuild-verify");
    expect(byRef["app:s1:webuuid"].rebuildDeclined).toBeUndefined();
    await expect(plan(build(), ["app:s1:dbuuid"])).rejects.toMatchObject({ response: { code: "takeover_rebuild_needs_side_by_side" } });
  });
  it("an app the op does not have is still refused by name", async () => {
    await expect(prepare(build(), ["app:s1:ghost"])).rejects.toMatchObject({ response: { code: "takeover_unknown_item" } });
  });
  it("the run view says, per app, what was chosen and what happened: names, refs, states and codes only", async () => {
    const t = build();
    await prepare(t, ["app:s1:webuuid", "app:s1:dbuuid"]);
    const v = await t.svc.runView(ACTOR, "run1");
    expect(v.status).toBe("TESTING");
    expect(v.items.map((i) => [i.itemRef, i.buildMode, i.rebuildDeclined ?? false])).toEqual([
      ["app:s1:webuuid", "rebuild-verify", false],
      ["app:s1:dbuuid", "reuse-image", true],
    ]);
    expect(Object.keys(v).sort()).toEqual(["failureCode", "id", "items", "pending", "status", "verified"]);
    expect(JSON.stringify(v)).not.toMatch(/sha256|tugra_app|[0-9a-f]{64}|"restart"|"image"|bindBefore|proxy/);
  });
  it("the run view is for the team's owner and admin; another team's member sees nothing, and a run with no takeover is a 404", async () => {
    const t = build();
    await prepare(t, []);
    t.access.teamRole.mockResolvedValueOnce(Role.ADMIN);
    await expect(t.svc.runView("u2", "run1")).resolves.toMatchObject({ status: "TESTING" });
    t.access.teamRole.mockResolvedValueOnce(null);
    await expect(t.svc.runView("u3", "run1")).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.svc.runView(ACTOR, "run-none")).rejects.toBeInstanceOf(NotFoundException);
  });
});


// ───────────────────────────── lifecycle: give back after cleanup, interruption, run ownership, port watch ─────────────────────────────

describe("give back after Coolify's leftovers were cleaned up", () => {
  it("the hub refuses it with a clear code before anything is stopped, and a run's undo is refused the same way", async () => {
    const t = build();
    const v = await swapOk(t);
    t.rows.get(v.id)!.giveBackAvailable = false; // what the cleanup writes
    const before = t.box.events.length;
    await expect(t.svc.giveBack(ACTOR, v.id, { confirm: "edge-box" })).rejects.toMatchObject({ response: { code: "takeover_cleaned" } });
    expect(t.box.events.slice(before)).toEqual([]); // Tugra's copies are still running, nothing was stopped
    expect(t.box.stoppedApps).toEqual([]);
    expect(t.rows.get(v.id)!.status).toBe("SWAPPED");
    t.rows.get(v.id)!.runId = "run1";
    await expect(t.svc.runGiveBack(ACTOR, "run1")).rejects.toMatchObject({ response: { code: "takeover_cleaned" } });
    expect(t.box.stoppedApps).toEqual([]);
  });
  it("Coolify's containers are checked to still exist BEFORE Tugra's copies are stopped: if they are gone Tugra keeps serving", async () => {
    const t = build();
    const v = await swapOk(t);
    t.box.ctrs.delete(data.ctrId); // removed behind the hub's back (a manual prune)
    const r = await t.svc.giveBack(ACTOR, v.id, { confirm: "edge-box" });
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("give_back_failed");
    expect(t.box.stoppedApps).toEqual([]); // Tugra's copy of the app that shares data was not stopped
    expect(t.box.tugraRunning.has(data.appId)).toBe(true);
  });
});

describe("an interrupted swap or give-back", () => {
  it("an error inside the swap reverses by itself: FAILED swap_error with Coolify running again, not SWAPPING with Coolify stopped", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    // the agent drops after Coolify's database-owning app was stopped and Tugra's copy started
    const real = t.box.startProxy.bind(t.box);
    let boom = true;
    t.box.runAdopted = async (...a: Parameters<Box["runAdopted"]>) => {
      if (boom && a[1] === data.appId) {
        boom = false;
        throw new Error("agent disconnected");
      }
      return Box.prototype.runAdopted.apply(t.box, a);
    };
    void real;
    const r = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(r.status).toBe("FAILED");
    expect(r.failureCode).toBe("swap_error");
    expect(t.box.ctrs.get(data.ctrId)!.running).toBe(true); // Coolify's container runs again
    expect(t.box.coolifyProxy.running).toBe(true);
  });
  it("a refusal before anything changed (the gate) is still thrown as it was and leaves the takeover TESTING", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    await expect(t.svc.swap(ACTOR, p.id, { confirm: "wrong" })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.rows.get(p.id)!.status).toBe("TESTING");
  });
  it("a give-back the hub restarted in the middle of can be pressed again (GIVING_BACK, nothing running in this process)", async () => {
    const t = build();
    const v = await swapOk(t);
    t.rows.get(v.id)!.status = "GIVING_BACK";
    const r = await t.svc.giveBack(ACTOR, v.id, { confirm: "edge-box" });
    expect(r.status).toBe("GIVEN_BACK");
    expect(t.box.coolifyProxy.running).toBe(true);
  });
  it("a give-back that is really running is still refused as busy: it never runs twice", async () => {
    const t = build();
    const v = await swapOk(t);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const stop = t.box.stopApp.bind(t.box);
    t.box.stopApp = async (...a: Parameters<Box["stopApp"]>) => {
      await gate;
      return stop(...a);
    };
    const first = t.svc.giveBack(ACTOR, v.id, { confirm: "edge-box" });
    await new Promise((r) => setImmediate(r));
    await expect(t.svc.giveBack(ACTOR, v.id, { confirm: "edge-box" })).rejects.toMatchObject({ message: "takeover_busy" });
    release();
    await expect(first).resolves.toMatchObject({ status: "GIVEN_BACK" });
  });
  it("an error that escapes the give-back does not leave GIVING_BACK behind: it ends FAILED so it can be pressed again", async () => {
    const t = build();
    const v = await swapOk(t);
    const orig = t.prisma.coolifyTakeover.findUnique.getMockImplementation()!;
    let n = 0;
    // the first read is the action's own; the second is the undo's, which the database refuses once
    t.prisma.coolifyTakeover.findUnique.mockImplementation(async (a: { where: { id: string } }) => {
      n += 1;
      if (n === 2) throw new Error("db hiccup");
      return orig(a);
    });
    const r = await t.svc.giveBack(ACTOR, v.id, { confirm: "edge-box" });
    expect(r).toMatchObject({ status: "FAILED", failureCode: "give_back_failed" });
    t.prisma.coolifyTakeover.findUnique.mockImplementation(orig);
    await expect(t.svc.giveBack(ACTOR, v.id, { confirm: "edge-box" })).resolves.toMatchObject({ status: "GIVEN_BACK" });
  });
  it("at boot, a row left in SWAPPING or GIVING_BACK by a process that is gone ends FAILED so it can be given back; other rows are left alone", async () => {
    const t = build();
    const a = await swapOk(t);
    t.rows.get(a.id)!.status = "SWAPPING";
    const b = build();
    const bv = await swapOk(b);
    b.rows.get(bv.id)!.status = "GIVING_BACK";
    expect(await t.svc.recoverInterrupted()).toBe(1);
    expect(t.rows.get(a.id)).toMatchObject({ status: "FAILED", failureCode: "swap_interrupted" });
    expect(await b.svc.recoverInterrupted()).toBe(1);
    expect(b.rows.get(bv.id)).toMatchObject({ status: "FAILED", failureCode: "give_back_failed" });
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.recover", meta: { from: "SWAPPING", failure: "swap_interrupted" } }));
    // and from FAILED the owner can give back: Coolify runs again
    const r = await t.svc.giveBack(ACTOR, a.id, { confirm: "edge-box" });
    expect(r.status).toBe("GIVEN_BACK");
    expect(t.box.coolifyProxy.running).toBe(true);
    // nothing in a healthy state is touched
    const c = build();
    await swapOk(c);
    expect(await c.svc.recoverInterrupted()).toBe(0);
  });
});

describe("a takeover a live guided run drives", () => {
  it("the standalone test, swap, verify and give-back refuse it (409 takeover_owned_by_run); the run's own calls still work", async () => {
    const t = build();
    t.box.liveRuns.add("run1");
    const st = await t.svc.runPrepare(ACTOR, { runId: "run1", serverId: "srv1", opId: "op1" });
    expect(st.status).toBe("TESTING");
    for (const call of [() => t.svc.test(ACTOR, st.id), () => t.svc.swap(ACTOR, st.id, { confirm: "edge-box" }), () => t.svc.verify(ACTOR, st.id), () => t.svc.giveBack(ACTOR, st.id, { confirm: "edge-box" })]) {
      await expect(call()).rejects.toMatchObject({ response: { code: "takeover_owned_by_run", runId: "run1" } });
    }
    expect(t.rows.get(st.id)!.status).toBe("TESTING");
    expect(t.box.events.filter((e) => e.startsWith("coolify-proxy"))).toEqual([]);
    expect((await t.svc.runSwap(ACTOR, "run1")).status).toBe("SWAPPED");
  });
  it("the view says which run drives it while the run is live, and nothing once the run ended: then the standalone screen is the owner's", async () => {
    const t = build();
    t.box.liveRuns.add("run1");
    const st = await t.svc.runPrepare(ACTOR, { runId: "run1", serverId: "srv1", opId: "op1" });
    expect((await t.svc.list(ACTOR, "srv1"))[0].runId).toBe("run1");
    t.box.liveRuns.delete("run1");
    expect((await t.svc.list(ACTOR, "srv1"))[0].runId).toBeNull();
    // an ended run's takeover can be given back standalone
    await t.svc.runSwap(ACTOR, "run1");
    const r = await t.svc.giveBack(ACTOR, st.id, { confirm: "edge-box" });
    expect(r.status).toBe("GIVEN_BACK");
  });
});

describe("the ports are watched after the swap", () => {
  it("verify says swap_lost (and the takeover is not VERIFIED) when Coolify's proxy runs again; once it is stopped again the next pass passes", async () => {
    const t = build();
    const v = await swapOk(t);
    await t.svc.verify(ACTOR, v.id); // certificates are issued
    expect(t.rows.get(v.id)!.status).toBe("VERIFIED");
    t.box.coolifyProxy.running = true; // Coolify (or someone) started its proxy again
    const lost = await t.svc.verify(ACTOR, v.id);
    expect(lost.status).toBe("SWAPPED");
    expect(lost.failureCode).toBe("swap_lost");
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.verify", meta: expect.objectContaining({ failure: "swap_lost", coolifyProxyRunning: true }) }));
    t.box.coolifyProxy.running = false;
    const back = await t.svc.verify(ACTOR, v.id);
    expect(back.status).toBe("VERIFIED");
    expect(back.failureCode).toBeNull();
  });
  it("also when Tugra's proxy lost the ports", async () => {
    const t = build();
    const v = await swapOk(t);
    t.box.tugraProxy = { state: "running", published: false };
    expect((await t.svc.verify(ACTOR, v.id)).failureCode).toBe("swap_lost");
  });
  it("the timer watches a VERIFIED takeover that can still be given back, and stays quiet while the ports are Tugra's", async () => {
    const t = build();
    const v = await swapOk(t);
    await t.svc.verify(ACTOR, v.id);
    await t.svc.sweepFallbacks();
    expect(t.rows.get(v.id)!.status).toBe("VERIFIED");
    t.box.coolifyProxy.running = true;
    await t.svc.sweepFallbacks();
    expect(t.rows.get(v.id)).toMatchObject({ status: "SWAPPED", failureCode: "swap_lost" });
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ failure: "swap_lost", auto: true }) }));
  });
});

describe("what the view says after a put-back", () => {
  it("a swap that failed and reversed itself is reversed: the screen never offers a Test the hub refuses", async () => {
    const t = build();
    t.box.failProxyStop = true;
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    const r = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(r.status).toBe("FAILED");
    expect(r.reversed).toBe(true);
    await expect(t.svc.test(ACTOR, p.id)).rejects.toMatchObject({ message: "takeover_plan_again" });
    expect((await plan(t)).reversed).toBe(false);
  });
});

describe("the exact image the source runs is kept in the records (digest and version label read from the container)", () => {
  const D1 = `sha256:${"1".repeat(64)}`;
  const D2 = `sha256:${"2".repeat(64)}`;

  it("an app: the digest and version label the host reports are handed to the world after the image was adopted, with the image as Coolify runs it", async () => {
    const t = build({ apps: [{ ...web, image: "ghcr.io/example/web:latest", repoDigests: [`ghcr.io/example/web@${D1}`], version: "2.4.1" }] });
    const p = await plan(t);
    expect(t.box.exactPins).toEqual([]); // reading changes nothing
    await t.svc.test(ACTOR, p.id);
    expect(t.box.exactPins).toEqual([{ kind: "app", id: "appweb", image: "ghcr.io/example/web:latest", repoDigests: [`ghcr.io/example/web@${D1}`], version: "2.4.1" }]);
    expect(t.box.events.indexOf("tag:tugra_appweb:dep1")).toBeLessThan(t.box.events.indexOf("exact:app:appweb"));
    const stored = JSON.stringify([...t.rows.values()][0].items);
    expect(stored).toContain(D1); // the recorded container keeps what the host reported
  });

  it("a host that reports no digest and no label (an older script, a locally built image) still takes over; the world is asked with nothing to pin", async () => {
    const t = build({ apps: [web] });
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(v.status).toBe("TESTING");
    expect(t.box.exactPins).toEqual([{ kind: "app", id: "appweb", image: "webuuid:aaa111" }]);
  });

  it("a world that cannot write the record, or fails to, never stops the takeover", async () => {
    const t = build({ apps: [{ ...web, repoDigests: [`webuuid@${D1}`] }] });
    t.box.failExactPin = true;
    const v = await t.svc.test(ACTOR, (await plan(t)).id);
    expect(v.status).toBe("TESTING");
    expect(v.failureCode).toBeNull();
    const old = build({ apps: [web] });
    (old.box as unknown as { pinExact?: unknown }).pinExact = undefined;
    expect((await old.svc.test(ACTOR, (await plan(old)).id)).status).toBe("TESTING");
  });

  it("a database whose record is pinned to the exact image (postgres:16-alpine@sha256:...) is still the image Coolify's container runs", async () => {
    const t = withDb({ db: { tugraImage: `postgres:16-alpine@${D2}`, repoDigests: [`postgres@${D2}`] } });
    expect(dbItem(await plan(t))).toMatchObject({ kind: "database" });
    expect(dbItem(await plan(t)).skipped).toBeUndefined();
    const other = withDb({ db: { tugraImage: `postgres:17-alpine@${D2}` } });
    expect(dbItem(await plan(other))).toMatchObject({ skipped: true, issues: ["db_image_differs"] });
  });

  it("a database is handed its digest before it is prepared", async () => {
    const t = withDb({ db: { repoDigests: [`postgres@${D2}`], version: "16.4" } });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    expect(t.box.exactPins).toContainEqual({ kind: "database", id: "db1", image: "postgres:16-alpine", repoDigests: [`postgres@${D2}`], version: "16.4" });
  });
});
