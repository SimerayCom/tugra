import { Role } from "@prisma/client";
import { CoolifyInPlaceService } from "./coolify-inplace.service";
import { Box, H, type BoxApp, type BoxDb, type BoxService } from "./inplace-box";
import { PlanSchema } from "./dto";

const ACTOR = "u1";

/** A Coolify one-click service with two containers: a web container that needs its database, and the database. */
const blog = (over: Partial<BoxService> = {}): BoxService => ({
  appId: "appsvc",
  itemRef: "service:s1:svcuuid",
  name: "blog",
  hosts: ["blog.example.com"],
  project: "tugra_appsvc",
  compose: [
    { service: "ghost", image: "ghost:5", dependsOn: ["db"], named: [{ source: "content", target: "/var/lib/ghost/content" }] },
    { service: "db", image: "postgres:16", named: [{ source: "pgdata", target: "/var/lib/postgresql/data" }] },
  ],
  composeVolumes: [
    { key: "content", dockerName: "tugra_appsvc_content", external: false },
    { key: "pgdata", dockerName: "tugra_appsvc_pgdata", external: false },
  ],
  members: [
    {
      service: "ghost",
      ctrId: H("5"),
      ctrName: "ghost-svcuuid",
      image: "ghost:5",
      mounts: [{ type: "volume", source: "svcuuid_content", dest: "/var/lib/ghost/content", rw: true }],
      networks: [
        { name: "svcuuid", aliases: ["ghost", "aabbccddeeff"] },
        { name: "coolify", aliases: ["ghost"] },
      ],
    },
    {
      service: "db",
      ctrId: H("6"),
      ctrName: "db-svcuuid",
      image: "postgres:16",
      mounts: [{ type: "volume", source: "svcuuid_pgdata", dest: "/var/lib/postgresql/data", rw: true }],
      networks: [{ name: "svcuuid", aliases: ["db"] }],
      restart: "always",
    },
  ],
  ...over,
});

/** A stateless service: one container, no data, no published port. It can run next to Coolify's. */
const stateless = (): BoxService =>
  blog({
    appId: "appstl",
    itemRef: "service:s1:stluuid",
    name: "status",
    hosts: ["status.example.com"],
    project: "tugra_appstl",
    compose: [{ service: "web", image: "nginx:1.27" }],
    composeVolumes: [],
    members: [{ service: "web", ctrId: H("7"), ctrName: "web-stluuid", image: "nginx:1.27", networks: [{ name: "stluuid", aliases: ["web"] }] }],
  });

/** A stateless service with a database-like member that keeps nothing on a volume (a cache). */
const statelessRedis = (): BoxService =>
  blog({
    appId: "appstl",
    itemRef: "service:s1:stluuid",
    name: "status",
    hosts: ["status.example.com"],
    project: "tugra_appstl",
    compose: [
      { service: "web", image: "nginx:1.27", dependsOn: ["cache"] },
      { service: "cache", image: "redis:7" },
    ],
    composeVolumes: [],
    members: [
      { service: "web", ctrId: H("7"), ctrName: "web-stluuid", image: "nginx:1.27", networks: [{ name: "stluuid", aliases: ["web"] }] },
      { service: "cache", ctrId: H("9"), ctrName: "cache-stluuid", image: "redis:7", networks: [{ name: "stluuid", aliases: ["cache"] }] },
    ],
  });

const web: BoxApp = { appId: "appweb", itemRef: "app:s1:webuuid", name: "web", host: "web.example.com", ctrId: H("a"), ctrName: "webuuid-20261125T101010", image: "webuuid:aaa111" };

function build(o: { role?: Role | null; services?: BoxService[]; apps?: BoxApp[]; dbs?: BoxDb[] } = {}) {
  const box = new Box();
  for (const a of o.apps ?? []) box.add(a);
  for (const d of o.dbs ?? []) box.addDb(d);
  for (const s of o.services ?? [blog()]) box.addService(s);
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
      findMany: jest.fn(async () => [...rows.values()].map((r) => ({ ...r, createdAt: new Date("2026-11-26T10:00:00Z"), finishedAt: null }))),
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
  return { svc, box, rows, audit };
}
type T = ReturnType<typeof build>;

const plan = (t: T) => t.svc.plan(ACTOR, PlanSchema.parse({ serverId: "srv1", opId: "op1" }));
const swapOk = async (t: T) => {
  const p = await plan(t);
  await t.svc.test(ACTOR, p.id);
  return t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
};
const itemsOf = (t: T): Array<Record<string, unknown>> => [...t.rows.values()][0].items as Array<Record<string, unknown>>;
const at = (t: T, e: string): number => t.box.events.indexOf(e);

describe("plan: every container of the service is mapped", () => {
  it("maps both containers in start order (the database first), shares data so it is switched, and keeps no ids or names in the view", async () => {
    const t = build();
    const v = await plan(t);
    expect(v.items).toHaveLength(1);
    const it = v.items[0];
    expect(it).toMatchObject({ itemRef: "service:s1:svcuuid", name: "blog", kind: "service", exclusive: true, buildMode: "reuse-image" });
    expect(it.skipped).toBeUndefined();
    expect(it.members).toEqual([
      { name: "db", ready: "pending" },
      { name: "ghost", ready: "pending" },
    ]);
    expect(it.domains.map((d) => d.host)).toEqual(["blog.example.com"]);
    expect(JSON.stringify(v)).not.toMatch(/[0-9a-f]{64}|ghost-svcuuid|svcuuid_|sha256|tugra_appsvc/);
    // reading changes nothing on the box
    expect(t.box.events).toEqual([]);
  });
  it("the stored item records which Coolify container is which compose service, their volume aliases and the databases to check", async () => {
    const t = build();
    await plan(t);
    const stored = itemsOf(t)[0] as { members: Array<Record<string, unknown>>; project: string };
    expect(stored.project).toBe("tugra_appsvc");
    expect(stored.members.map((m) => m.service)).toEqual(["db", "ghost"]);
    expect(stored.members[0]).toMatchObject({ engine: "POSTGRES", volumes: [{ from: "svcuuid_pgdata", to: "tugra_appsvc_pgdata", key: "pgdata" }] });
    expect(stored.members[1]).toMatchObject({ volumes: [{ from: "svcuuid_content", to: "tugra_appsvc_content", key: "content" }] });
    expect(stored.members[1].engine).toBeUndefined();
  });
  it("keeps Coolify's network names: the per-service network under the container name, the proxy network left to Tugra's routing", async () => {
    const t = build();
    await plan(t);
    const stored = itemsOf(t)[0] as { networksWanted: Array<{ network: string; service: string; aliases: string[] }> };
    expect(stored.networksWanted).toEqual(
      expect.arrayContaining([
        { network: "svcuuid", service: "ghost", aliases: ["ghost-svcuuid"] },
        { network: "svcuuid", service: "db", aliases: ["db-svcuuid"] },
      ]),
    );
    expect(stored.networksWanted).toHaveLength(2); // the compose service name and the short id are not repeated, "coolify" is not carried
  });
  it("a service with no domain is still taken over (an internal service is not a skipped app)", async () => {
    const t = build({ services: [blog({ hosts: [] })] });
    const v = await plan(t);
    expect(v.items[0].skipped).toBeUndefined();
    expect(v.items[0].issues).toBeUndefined();
  });
  it("a service that shares no data and publishes no port runs alongside; a published host port makes it exclusive", async () => {
    const a = build({ services: [stateless()] });
    expect((await plan(a)).items[0].exclusive).toBeUndefined();
    const s = stateless();
    s.members[0].published = 1;
    const b = build({ services: [s] });
    expect((await plan(b)).items[0].exclusive).toBe(true);
  });
  it("a bind mount of a host folder is carried by the volume the import made of it, and a read-only config file needs no counterpart", async () => {
    const s = blog();
    s.members[0].mounts = [
      { type: "bind", source: "/data/coolify/services/svcuuid/uploads", dest: "/var/lib/ghost/content", rw: true },
      { type: "bind", source: "/data/coolify/services/svcuuid/ghost.cfg", dest: "/etc/ghost.cfg", rw: false },
    ];
    const t = build({ services: [s] });
    const v = await plan(t);
    expect(v.items[0].skipped).toBeUndefined();
    const stored = itemsOf(t)[0] as { members: Array<{ service: string; binds: unknown[] }> };
    expect(stored.members.find((m) => m.service === "ghost")!.binds).toEqual([{ from: "/data/coolify/services/svcuuid/uploads", to: "tugra_appsvc_content", key: "content" }]);
  });

  it("leaves the whole service out when a container has no compose service of the Tugra app (a dropped member), with the reason", async () => {
    const s = blog();
    s.members.push({ service: "worker", ctrId: H("8"), ctrName: "worker-svcuuid", image: "ghost:5" });
    const t = build({ services: [s] });
    expect((await plan(t)).items[0]).toMatchObject({ skipped: true, issues: ["service_member_unmapped"] });
  });
  it("a container without the compose service label cannot be mapped", async () => {
    const s = blog();
    s.members[0].noLabel = true;
    const t = build({ services: [s] });
    expect((await plan(t)).items[0]).toMatchObject({ skipped: true, issues: expect.arrayContaining(["service_member_unmapped", "service_member_absent"]) });
  });
  it("a compose service Coolify runs no container for is a member that is absent", async () => {
    const s = blog();
    s.compose.push({ service: "cache", image: "redis:7" });
    const t = build({ services: [s] });
    expect((await plan(t)).items[0]).toMatchObject({ skipped: true, issues: ["service_member_absent"] });
  });
  it("two containers for one compose service are ambiguous", async () => {
    const s = blog();
    s.members.push({ service: "ghost", ctrId: H("9"), ctrName: "ghost-2-svcuuid", image: "ghost:5" });
    const t = build({ services: [s] });
    expect((await plan(t)).items[0]).toMatchObject({ skipped: true, issues: ["service_member_ambiguous"] });
  });
  it("a service the Tugra app builds or writes with a variable image cannot be reused", async () => {
    const a = blog();
    a.compose[0].image = null;
    expect((await plan(build({ services: [a] }))).items[0]).toMatchObject({ skipped: true, issues: ["service_image_differs"] });
    const b = blog();
    b.compose[0].image = "ghost:${GHOST_TAG}";
    expect((await plan(build({ services: [b] }))).items[0]).toMatchObject({ skipped: true, issues: ["service_image_differs"] });
  });
  it("a tag that now points at another image than the container runs is refused (the image is compared by id), and an absent image too", async () => {
    const t = build();
    t.box.imageIds.set("ghost:5", `sha256:${H("f")}`);
    expect((await plan(t)).items[0]).toMatchObject({ skipped: true, issues: ["service_image_moved"] });
    const u = build();
    u.box.missingImages.add("postgres:16");
    expect((await plan(u)).items[0]).toMatchObject({ skipped: true, issues: ["image_missing"] });
  });
  it("a writable volume or folder with no counterpart in the compose app keeps the service out: starting without its data would be worse", async () => {
    const a = blog();
    a.members[0].mounts = [...(a.members[0].mounts ?? []), { type: "volume", source: "svcuuid_extra", dest: "/extra", rw: true }];
    expect((await plan(build({ services: [a] }))).items[0]).toMatchObject({ skipped: true, issues: ["volume_unmapped"] });
    const b = blog();
    b.members[0].mounts = [...(b.members[0].mounts ?? []), { type: "bind", source: "/srv/x", dest: "/x", rw: true }];
    expect((await plan(build({ services: [b] }))).items[0]).toMatchObject({ skipped: true, issues: ["bind_unmapped"] });
  });
  it("an anonymous volume declared by the compose where Coolify's container holds data is refused", async () => {
    const a = blog();
    a.compose[0].named = [];
    a.compose[0].anonymous = ["/var/lib/ghost/content"];
    expect((await plan(build({ services: [a] }))).items[0]).toMatchObject({ skipped: true, issues: ["volume_unmapped"] });
  });
  it("a network name that cannot be carried is an issue, never a quiet loss", async () => {
    const s = blog();
    s.members[0].networks = [{ name: "Odd_Net", aliases: [] }];
    expect((await plan(build({ services: [s] }))).items[0]).toMatchObject({ skipped: true, issues: ["service_networks_unmapped"] });
  });
  it("a compose app the takeover cannot drive (a git compose, an adopted project) is left out", async () => {
    const t = build({ services: [blog({ usable: false })] });
    expect((await plan(t)).items[0]).toMatchObject({ skipped: true, issues: ["service_compose_unsupported"] });
  });
  it("a service whose containers are not running is left out with container_absent", async () => {
    const t = build();
    for (const m of t.box.services[0].members) t.box.ctrs.get(m.ctrId)!.running = false;
    expect((await plan(t)).items[0]).toMatchObject({ skipped: true, issues: ["container_absent"] });
  });
  it("the other items are planned as before when one service is left out", async () => {
    const s = blog();
    s.compose.push({ service: "cache", image: "redis:7" });
    const t = build({ services: [s, stateless()], apps: [web] });
    const v = await plan(t);
    expect(Object.fromEntries(v.items.map((i) => [i.itemRef, !!i.skipped]))).toEqual({ "app:s1:webuuid": false, "service:s1:svcuuid": true, "service:s1:stluuid": false });
  });
  it("rebuilding a service with Tugra is not a thing: only apps are in the rebuild list", async () => {
    const t = build();
    await expect(t.svc.plan(ACTOR, PlanSchema.parse({ serverId: "srv1", opId: "op1", rebuild: ["service:s1:svcuuid"] }))).rejects.toMatchObject({ response: { code: "takeover_unknown_item" } });
  });
  it("audits the plan with counts only", async () => {
    const t = build({ services: [blog(), stateless()] });
    await plan(t);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.plan", meta: expect.objectContaining({ services: 2, apps: 0 }) }));
  });
});

describe("test: data and images reused in place", () => {
  it("aliases every volume to the Coolify volume (no copy) stamped for compose, adopts the stack, reads the database's yardstick and starts nothing next to Coolify's", async () => {
    const t = build();
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(v.status).toBe("TESTING");
    expect(t.box.svcAliases.get("tugra_appsvc_pgdata")).toEqual({ kind: "volume", from: "svcuuid_pgdata", project: "tugra_appsvc", key: "pgdata" });
    expect(t.box.svcAliases.get("tugra_appsvc_content")).toMatchObject({ from: "svcuuid_content" });
    expect(t.box.events).toContain("compose-adopt:appsvc");
    expect(t.box.tugraSvcRunning.size).toBe(0);
    expect(t.box.ctrs.get(H("5"))!.running && t.box.ctrs.get(H("6"))!.running).toBe(true);
    expect(itemsOf(t)[0]).toMatchObject({ state: "prepared", members: [{ dbBefore: { state: "ok", level: "counts" } }, {}] });
  });
  it("a host folder becomes a bind volume on that same folder", async () => {
    const s = blog();
    s.members[0].mounts = [{ type: "bind", source: "/data/coolify/services/svcuuid/uploads", dest: "/var/lib/ghost/content", rw: true }];
    const t = build({ services: [s] });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    expect(t.box.svcAliases.get("tugra_appsvc_content")).toMatchObject({ kind: "bind", from: "/data/coolify/services/svcuuid/uploads" });
  });
  it("a Tugra volume that already exists and is not the alias keeps the service out", async () => {
    const t = build();
    t.box.svcAliases.set("tugra_appsvc_pgdata", { kind: "volume", from: "another", project: "x", key: "pgdata" });
    const p = await plan(t);
    expect((await t.svc.test(ACTOR, p.id)).items[0]).toMatchObject({ skipped: true, issues: ["volume_alias_foreign"] });
    expect(t.box.events).not.toContain("compose-adopt:appsvc");
  });
  it("a Coolify volume that is gone keeps the service out", async () => {
    const t = build();
    const p = await plan(t);
    t.box.volumes.delete("svcuuid_content");
    expect((await t.svc.test(ACTOR, p.id)).items[0]).toMatchObject({ skipped: true, issues: ["volume_alias_failed"] });
  });
  it("an image that moved between the plan and the test keeps the service out before any volume is touched", async () => {
    const t = build();
    const p = await plan(t);
    t.box.imageIds.set("postgres:16", `sha256:${H("f")}`);
    expect((await t.svc.test(ACTOR, p.id)).items[0]).toMatchObject({ skipped: true, issues: ["service_image_moved"] });
    expect(t.box.svcAliases.size).toBe(0);
  });
  it("a database-like container that cannot be read the way its engine is checked keeps the service out: a switch nobody could verify would be a guess", async () => {
    const t = build();
    t.box.dbReadFails.add(H("6"));
    const p = await plan(t);
    expect((await t.svc.test(ACTOR, p.id)).items[0]).toMatchObject({ skipped: true, issues: ["db_verify_failed"] });
  });
  it("a stateless service runs next to Coolify's, is waited for member by member, and its domain is tested dark against what Coolify answered", async () => {
    const t = build({ services: [stateless()] });
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(t.box.tugraSvcRunning.has("appstl")).toBe(true);
    expect(v.items[0].members).toEqual([{ name: "web", ready: "ok" }]);
    expect(v.items[0].domains[0]).toMatchObject({ host: "status.example.com", tempCheck: "ok" });
    expect(t.box.ctrs.get(H("7"))!.running).toBe(true);
  });
  it("a stateless service whose page differs through Tugra fails its test and the swap is refused", async () => {
    const t = build({ services: [stateless()] });
    t.box.differs.add("status.example.com");
    const p = await plan(t);
    const v = await t.svc.test(ACTOR, p.id);
    expect(v.items[0].domains[0].tempCheck).toBe("failed");
    await expect(t.svc.swap(ACTOR, p.id, { confirm: "edge-box" })).rejects.toMatchObject({ response: { code: "takeover_test_failed", host: "status.example.com" } });
    expect(t.box.coolifyProxy.running).toBe(true);
  });
  it("a stateless service whose container exits is left out and its stack is stopped again", async () => {
    const t = build({ services: [stateless()] });
    t.box.svcExits.add("appstl:web");
    const p = await plan(t);
    expect((await t.svc.test(ACTOR, p.id)).items[0]).toMatchObject({ skipped: true, issues: ["prepare_failed"] });
    expect(t.box.tugraSvcRunning.has("appstl")).toBe(false);
  });
  it("a stack Tugra could not start is left out, stopped, with its reason", async () => {
    const t = build({ services: [stateless()] });
    t.box.failAdopted.add("appstl");
    const p = await plan(t);
    expect((await t.svc.test(ACTOR, p.id)).items[0]).toMatchObject({ skipped: true, issues: ["prepare_failed"] });
  });
  it("a container that keeps restarting is not ready (one running look cannot tell)", async () => {
    const t = build({ services: [stateless()] });
    t.box.svcCrashLoop.add("appstl:web");
    const p = await plan(t);
    expect((await t.svc.test(ACTOR, p.id)).items[0]).toMatchObject({ skipped: true, issues: ["prepare_failed"] });
    expect(t.box.sleeps).toBeGreaterThan(0);
  });
  it("can be pressed again without repeating what is done", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    await t.svc.test(ACTOR, p.id);
    expect(t.box.events.filter((e) => e === "compose-adopt:appsvc")).toHaveLength(1);
    expect(t.box.events.filter((e) => e.startsWith("svc-alias:"))).toHaveLength(2);
  });
});

describe("swap: in dependency order, with readiness", () => {
  it("stops dependents before the database, the database last, switches the network names, starts the stack and checks every container and the database", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.events.length = 0;
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("SWAPPED");
    expect(v.failureCode).toBeNull();
    // Coolify's side: the web container (the dependent) stops before the database, and the database's yardstick is read again before it stops
    expect(at(t, "coolify-ctr:stop:ghost-svcuuid")).toBeGreaterThanOrEqual(0);
    expect(at(t, "coolify-ctr:stop:ghost-svcuuid")).toBeLessThan(at(t, "dbfp"));
    expect(at(t, "dbfp")).toBeLessThan(at(t, "coolify-ctr:stop:db-svcuuid"));
    // Tugra's side: the network names first, then the stack on the data, then Coolify's proxy goes
    expect(at(t, "coolify-ctr:stop:db-svcuuid")).toBeLessThan(at(t, "networks:appsvc:2"));
    expect(at(t, "networks:appsvc:2")).toBeLessThan(at(t, "tugra-svc:start:appsvc"));
    expect(at(t, "tugra-svc:start:appsvc")).toBeLessThan(at(t, "coolify-proxy:stop"));
    expect(t.box.netRows.get("appsvc")).toHaveLength(2);
    expect(t.box.tugraSvcRunning.get("appsvc")).toHaveLength(2);
    // every Coolify container is stopped with its restart policy off (a reboot must not bring it back beside Tugra's)
    for (const id of [H("5"), H("6")]) expect(t.box.ctrs.get(id)).toMatchObject({ running: false, restart: "no" });
    expect(v.items[0].members).toEqual([
      { name: "db", ready: "ok", verify: { level: "counts", state: "ok" } },
      { name: "ghost", ready: "ok" },
    ]);
    expect(v.items[0].domains[0]).toMatchObject({ finalCheck: "ok", cert: "fallback" });
  });
  it("the database is checked against the yardstick read right before it stopped, not the one from the test", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.events.length = 0;
    await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(t.box.events.filter((e) => e === "dbfp")).toHaveLength(2); // once before it stops, once after Tugra's runs
  });
  it("a service that never ran next to Coolify's does not start twice: the box would refuse two containers on one writable volume", async () => {
    const t = build();
    await expect(swapOk(t)).resolves.toMatchObject({ status: "SWAPPED" });
  });
  it("a stateless service is not stopped on the Coolify side: it ran alongside and nothing was shared", async () => {
    const t = build({ services: [stateless()] });
    const v = await swapOk(t);
    expect(v.status).toBe("SWAPPED");
    expect(t.box.events.some((e) => e.startsWith("coolify-ctr:stop"))).toBe(false);
  });
  it("a stateless service takes on Coolify's network names at the switch, is recreated on them and waited for, before the proxies change", async () => {
    const t = build({ services: [stateless()] });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    expect(t.box.netRows.get("appstl")).toEqual([]); // beside Coolify's copy during the test it holds no Coolify names
    t.box.events.length = 0;
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("SWAPPED");
    expect(t.box.netRows.get("appstl")).toHaveLength(1);
    expect(t.box.tugraSvcRunning.get("appstl")).toHaveLength(1); // the running stack was started with them
    expect(at(t, "networks:appstl:1")).toBeLessThan(at(t, "tugra-svc:start:appstl"));
    expect(at(t, "tugra-svc:start:appstl")).toBeLessThan(at(t, "coolify-proxy:stop"));
    expect(t.box.events.some((e) => e.startsWith("coolify-ctr:stop"))).toBe(false);
    expect(v.items[0].members).toEqual([{ name: "web", ready: "ok" }]);
  });
  it("network names the hub refuses for a stateless service put the switch back before the ports change", async () => {
    const t = build({ services: [stateless()] });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.failComposeNetworks = true;
    t.box.events.length = 0;
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("exclusive_start_failed");
    expect(t.box.events).not.toContain("coolify-proxy:stop");
    expect(t.box.tugraSvcRunning.size).toBe(0);
    expect(t.box.ctrs.get(H("7"))!.running).toBe(true);
  });
  it("a stateless service that does not come up ready on the names puts the switch back and the names go back", async () => {
    const t = build({ services: [stateless()] });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.svcExits.add("appstl:web");
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.failureCode).toBe("service_not_ready");
    expect(t.box.netRows.get("appstl")).toEqual([]);
    expect(t.box.tugraSvcRunning.size).toBe(0);
  });
  it("give back puts a stateless service's own network rows back", async () => {
    const s = { ...stateless(), networks: [{ network: "private-net", service: "web", aliases: ["w"] }] };
    const t = build({ services: [s] });
    const p = await swapOk(t);
    expect(t.box.netRows.get("appstl")!.length).toBeGreaterThan(1);
    await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(t.box.netRows.get("appstl")).toEqual([{ network: "private-net", service: "web", aliases: ["w"] }]);
  });
  it("a stateless service with a database-like member is checked at the switch and reaches VERIFIED", async () => {
    const t = build({ services: [statelessRedis()] });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.events.length = 0;
    const sw = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(sw.status).toBe("SWAPPED");
    expect(t.box.events.filter((e) => e === "dbfp")).toHaveLength(2); // Coolify's now, Tugra's after
    expect(at(t, "dbfp")).toBeLessThan(at(t, "coolify-proxy:stop"));
    expect(sw.items[0].members).toEqual([
      { name: "cache", ready: "ok", verify: { level: "alive", state: "ok" } },
      { name: "web", ready: "ok" },
    ]);
    const v = await t.svc.verify(ACTOR, p.id);
    expect(v.status).toBe("VERIFIED");
  });
  it("a stateless service whose database-like member looks different through Tugra's container is put back", async () => {
    const t = build({ services: [statelessRedis()] });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.dbReadFails.add(H("9"));
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("service_verify_failed");
    expect(t.box.events).not.toContain("coolify-proxy:stop");
    expect(t.box.tugraSvcRunning.size).toBe(0);
  });
  it("a container of the stack that does not come up ready puts everything back: Coolify's containers run again with their policy, Tugra's stack stops, the names go back", async () => {
    const t = build();
    t.box.svcUnhealthy.add("appsvc:ghost");
    const v = await swapOk(t);
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("service_not_ready");
    expect(t.box.tugraSvcRunning.size).toBe(0);
    expect(t.box.ctrs.get(H("6"))).toMatchObject({ running: true, restart: "always" });
    expect(t.box.ctrs.get(H("5"))).toMatchObject({ running: true, restart: "unless-stopped" });
    expect(t.box.netRows.get("appsvc")).toEqual([]);
    expect(t.box.coolifyProxy.running).toBe(true);
    // the database started before the web container, as it was found
    const log = t.box.events.filter((e) => e.startsWith("coolify-ctr:start"));
    expect(log).toEqual(["coolify-ctr:start:db-svcuuid", "coolify-ctr:start:ghost-svcuuid"]);
  });
  it("a container that exits ends the wait at once", async () => {
    const t = build();
    t.box.svcExits.add("appsvc:ghost");
    const before = t.box.sleeps;
    const v = await swapOk(t);
    expect(v.failureCode).toBe("service_not_ready");
    expect(t.box.sleeps - before).toBeLessThan(5);
  });
  it("a container that keeps restarting is not ready and everything is put back", async () => {
    const t = build();
    t.box.svcCrashLoop.add("appsvc:db");
    const v = await swapOk(t);
    expect(v.failureCode).toBe("service_not_ready");
    expect(t.box.ctrs.get(H("6"))!.running).toBe(true);
  });
  it("a database that does not look the same through Tugra's container is put back with its data untouched", async () => {
    const t = build();
    t.box.dbDiffers.add("appsvc:db");
    const v = await swapOk(t);
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("service_verify_failed");
    expect(t.box.tugraSvcRunning.size).toBe(0);
    expect(t.box.ctrs.get(H("6"))!.running).toBe(true);
    expect(t.box.netRows.get("appsvc")).toEqual([]);
  });
  it("a database whose yardstick cannot be read again at the swap ends FAILED before anything of Coolify's database stopped", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.dbReadFails.add(H("6"));
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("service_verify_failed");
    expect(t.box.events.some((e) => e.startsWith("coolify-ctr:stop"))).toBe(true); // the web container had stopped; it runs again
    expect(t.box.ctrs.get(H("6"))!.running).toBe(true);
    expect(t.box.ctrs.get(H("5"))!.running).toBe(true);
    expect(t.box.ctrs.get(H("5"))!.restart).toBe("unless-stopped");
    expect(t.box.tugraSvcRunning.size).toBe(0);
  });
  it("a stack Tugra will not start puts everything back", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.failAdopted.add("appsvc");
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.failureCode).toBe("exclusive_start_failed");
    expect(t.box.ctrs.get(H("6"))).toMatchObject({ running: true, restart: "always" });
    expect(t.box.netRows.get("appsvc")).toEqual([]);
  });
  it("network attachments the hub refuses put everything back before the stack starts", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.failComposeNetworks = true;
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.failureCode).toBe("exclusive_start_failed");
    expect(t.box.events).not.toContain("tugra-svc:start:appsvc");
    expect(t.box.ctrs.get(H("5"))!.running).toBe(true);
    expect(t.box.ctrs.get(H("6"))!.running).toBe(true);
  });
  it("a container that will not stop aborts: the ones already stopped run again with their recorded policy", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.failStopCtr.add(H("6"));
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.failureCode).toBe("exclusive_stop_failed");
    expect(t.box.ctrs.get(H("5"))).toMatchObject({ running: true, restart: "unless-stopped" });
    expect(t.box.ctrs.get(H("6"))).toMatchObject({ running: true, restart: "always" });
    expect(t.box.events).not.toContain("tugra-svc:start:appsvc");
  });
  it("a restart policy that cannot be turned off stops nothing", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    t.box.failPolicyNo.add(H("5"));
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.failureCode).toBe("exclusive_policy_failed");
    expect(t.box.events.some((e) => e.startsWith("coolify-ctr:stop"))).toBe(false);
    expect(t.box.ctrs.get(H("5"))!.running).toBe(true);
  });
  it("a service that talks to a database taken over in place starts after that database and its Coolify side goes quiet first", async () => {
    const db: BoxDb = { dbId: "dbpg", itemRef: "database:s1:pguuid", name: "pg", engine: "POSTGRES", ctrId: H("c"), ctrName: "pguuid", image: "postgres:16", dataMount: "/var/lib/postgresql/data", mounts: [{ type: "volume", source: "pguuid-data", dest: "/var/lib/postgresql/data", rw: true }], volumes: [] };
    const t = build({ services: [stateless()], dbs: [db] });
    t.box.mentions.add("appstl");
    const p = await plan(t);
    expect(p.items.find((i) => i.kind === "service")).toMatchObject({ afterSwitch: true });
    await t.svc.test(ACTOR, p.id);
    expect(t.box.tugraSvcRunning.size).toBe(0); // not started next to Coolify's: the database is not there for it yet
    t.box.events.length = 0;
    const v = await t.svc.swap(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("SWAPPED");
    expect(at(t, "coolify-ctr:stop:web-stluuid")).toBeLessThan(at(t, "coolify-ctr:stop:pguuid"));
    expect(at(t, "tugra-db:start:dbpg")).toBeLessThan(at(t, "tugra-svc:start:appstl"));
  });
  it("is owner-only and needs the typed name", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    await expect(t.svc.swap(ACTOR, p.id, { confirm: "wrong" })).rejects.toMatchObject({ status: 400 });
  });
  it("audits the swap with counts only", async () => {
    const t = build();
    await swapOk(t);
    const call = (t.audit.log.mock.calls as unknown as Array<[{ action: string; meta: Record<string, unknown> }]>).find((c) => c[0].action === "coolify.takeover.swap")![0];
    expect(call.meta).toMatchObject({ apps: 1, switched: 1 });
    expect(JSON.stringify(call)).not.toMatch(/svcuuid|[0-9a-f]{64}/);
  });
});

describe("verify and give back", () => {
  it("is verified only when every container is ready, the database was checked and every domain holds a new certificate", async () => {
    const t = build();
    const p = await swapOk(t);
    const v = await t.svc.verify(ACTOR, p.id);
    expect(v.status).toBe("VERIFIED");
    expect(v.items[0].domains[0].cert).toBe("issued");
    expect(v.items[0].members!.every((m) => m.ready === "ok")).toBe(true);
  });
  it("a container that goes down after the switch is a visible failure and the takeover is not verified", async () => {
    const t = build();
    const p = await swapOk(t);
    t.box.svcExits.add("appsvc:ghost");
    const v = await t.svc.verify(ACTOR, p.id);
    expect(v.status).toBe("SWAPPED");
    expect(v.failureCode).toBe("service_not_ready");
    expect(v.items[0].members).toEqual(expect.arrayContaining([{ name: "ghost", ready: "failed" }]));
    t.box.svcExits.delete("appsvc:ghost");
    const again = await t.svc.verify(ACTOR, p.id);
    expect(again.status).toBe("VERIFIED");
    expect(again.failureCode).toBeNull();
  });
  it("a look that cannot be made says nothing: a container is not marked failed because the box did not answer", async () => {
    const t = build();
    const p = await swapOk(t);
    const orig = t.box.exec.bind(t.box);
    t.box.exec = async (s: string, script: string) => (script.includes("TUGRA_IP_SVC_END") ? { exitCode: 0, output: "cut" } : orig(s, script));
    const v = await t.svc.verify(ACTOR, p.id);
    expect(v.items[0].members!.every((m) => m.ready === "ok")).toBe(true);
  });
  it("give back restores every Coolify container of the service with its recorded policy, databases first, after Tugra's stack stopped and its network names went back", async () => {
    const t = build();
    const p = await swapOk(t);
    t.box.events.length = 0;
    const v = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("GIVEN_BACK");
    expect(t.box.ctrs.get(H("5"))).toMatchObject({ running: true, restart: "unless-stopped" });
    expect(t.box.ctrs.get(H("6"))).toMatchObject({ running: true, restart: "always" });
    expect(t.box.tugraSvcRunning.size).toBe(0);
    expect(t.box.netRows.get("appsvc")).toEqual([]);
    expect(at(t, "tugra-app:stop:appsvc")).toBeLessThan(at(t, "coolify-ctr:start:db-svcuuid"));
    expect(at(t, "coolify-ctr:start:db-svcuuid")).toBeLessThan(at(t, "coolify-ctr:start:ghost-svcuuid"));
    expect(at(t, "coolify-ctr:start:ghost-svcuuid")).toBeLessThan(at(t, "proxy:reverse"));
    expect(v.items[0].members).toEqual([{ name: "db", ready: "pending", verify: { level: "counts", state: "pending" } }, { name: "ghost", ready: "pending" }]);
    expect(v.items[0].domains[0]).toMatchObject({ finalCheck: "pending", cert: "pending" });
  });
  it("the network attachments the app had before the takeover come back, not an empty list", async () => {
    const s = blog({ networks: [{ network: "private-net", service: "db", aliases: ["pg"] }] });
    const t = build({ services: [s] });
    const p = await swapOk(t);
    expect(t.box.netRows.get("appsvc")).toHaveLength(3);
    await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(t.box.netRows.get("appsvc")).toEqual([{ network: "private-net", service: "db", aliases: ["pg"] }]);
  });
  it("works from a takeover that was only tested: an exclusive service was never started, so only the dark proxy goes", async () => {
    const t = build();
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    const v = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("GIVEN_BACK");
    expect(t.box.events.some((e) => e.startsWith("coolify-ctr:"))).toBe(false);
    expect(t.box.ctrs.get(H("5"))!.running).toBe(true);
  });
  it("stops the stack of a stateless service that ran alongside", async () => {
    const t = build({ services: [stateless()] });
    const p = await plan(t);
    await t.svc.test(ACTOR, p.id);
    expect(t.box.tugraSvcRunning.has("appstl")).toBe(true);
    await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(t.box.tugraSvcRunning.size).toBe(0);
  });
  it("network rows the hub refuses to restore never keep Coolify's containers down: they run first, the refusal is reported and the rows stay recorded", async () => {
    const t = build();
    const p = await swapOk(t);
    const orig = t.box.setComposeNetworks.bind(t.box);
    t.box.setComposeNetworks = async () => {
      throw new Error("hub busy");
    };
    const v = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v.status).toBe("GIVEN_BACK");
    expect(t.box.ctrs.get(H("5"))).toMatchObject({ running: true, restart: "unless-stopped" });
    expect(t.box.ctrs.get(H("6"))).toMatchObject({ running: true, restart: "always" });
    expect(t.box.netRows.get("appsvc")).toHaveLength(2); // not restored, and said so
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "coolify.takeover.give-back", meta: expect.objectContaining({ ok: true, networksNotRestored: 1 }) }));
    expect((itemsOf(t)[0] as { networksBefore?: unknown }).networksBefore).toBeDefined();
    t.box.setComposeNetworks = orig;
  });
  it("an automatic reversal after a service that is not ready starts Coolify's containers even when the network rows are refused", async () => {
    const t = build();
    t.box.svcUnhealthy.add("appsvc:ghost");
    const orig = t.box.setComposeNetworks.bind(t.box);
    let calls = 0;
    t.box.setComposeNetworks = async (u, id, rows) => {
      calls += 1;
      if (calls > 1) throw new Error("hub busy"); // the swap's own change goes through, the way back is refused
      return orig(u, id, rows);
    };
    const v = await swapOk(t);
    expect(v.status).toBe("FAILED");
    expect(v.failureCode).toBe("service_not_ready"); // not give_back_failed
    expect(t.box.ctrs.get(H("5"))!.running).toBe(true);
    expect(t.box.ctrs.get(H("6"))).toMatchObject({ running: true, restart: "always" });
    expect(at(t, "coolify-ctr:start:db-svcuuid")).toBeGreaterThanOrEqual(0);
  });
  it("a give-back that fails midway ends FAILED and pressing it again finishes the job", async () => {
    const t = build();
    const p = await swapOk(t);
    const orig = t.box.exec.bind(t.box);
    let fail = true;
    t.box.exec = async (s: string, script: string) => (fail && script.includes("start_one") ? { exitCode: 1, output: "" } : orig(s, script));
    const v1 = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v1.status).toBe("FAILED");
    expect(v1.failureCode).toBe("give_back_failed");
    fail = false;
    const v2 = await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    expect(v2.status).toBe("GIVEN_BACK");
    expect(t.box.netRows.get("appsvc")).toEqual([]);
    expect(t.box.ctrs.get(H("6"))!.running).toBe(true);
  });
  it("no script of the service takeover removes, kills or prunes anything, or asks for an environment", async () => {
    const t = build({ services: [blog(), stateless()] });
    const p = await swapOk(t);
    await t.svc.verify(ACTOR, p.id);
    await t.svc.giveBack(ACTOR, p.id, { confirm: "edge-box" });
    for (const s of t.box.scripts) {
      expect(s).not.toMatch(/docker\s+(rm|kill|prune|rmi|system|container\s+rm)\b/);
      expect(s).not.toMatch(/docker\s+volume\s+(rm|prune)/);
      expect(s).not.toMatch(/\.Config\.Env|\.Env\b|--env|printenv/);
    }
  });
  it("a non-owner cannot touch a service takeover and a non-member cannot tell it exists", async () => {
    const a = build({ role: Role.ADMIN });
    await expect(plan(a)).rejects.toMatchObject({ status: 403 });
    const b = build({ role: null });
    await expect(plan(b)).rejects.toMatchObject({ status: 404 });
  });
});
