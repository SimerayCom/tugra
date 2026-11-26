import { TAKEOVER_STATUSES, TAKEOVER_CERT_STATES, type TakeoverStatus } from "@tugra/shared";
import { ctrsOf, hasCtrs, membersVerified, stopCtrs, adoptTagFor, canCertTransition, canGiveBack, canTakeoverTransition, cleanCommit, certWorkLeft, domainsOf, FALLBACK_MAX_MS, isVerified, overdueFallbacks, judgeProbe, mapDbMounts, mapMounts, portsMayBeTugras, sameImageRef, swapGate, toItemView, type TakeoverItem } from "./inplace-plan";
import type { ProbeResult } from "./inplace-scripts";

const H = (c: string) => c.repeat(64);
const probe = (status: number | null, hash: string | null = H("a"), hash2: string | null = hash): ProbeResult => ({ status, hash, hash2 });

describe("judgeProbe", () => {
  it("the same status and the same content passes", () => {
    expect(judgeProbe(probe(200), probe(200))).toEqual({ ok: true, reason: "ok" });
  });
  it("a different content hash fails when Coolify's page is stable", () => {
    expect(judgeProbe(probe(200, H("a")), probe(200, H("b")))).toEqual({ ok: false, reason: "content_differs" });
  });
  it("a page that changes on every request is judged by status only", () => {
    expect(judgeProbe(probe(200, H("a"), H("c")), probe(200, H("b")))).toEqual({ ok: true, reason: "status_only" });
  });
  it("a host that cannot hash is judged by status only", () => {
    expect(judgeProbe(probe(200, null, null), probe(200, H("b")))).toEqual({ ok: true, reason: "status_only" });
    expect(judgeProbe(probe(200, H("a")), probe(200, null, null))).toEqual({ ok: true, reason: "status_only" });
  });
  it("a different status fails", () => {
    expect(judgeProbe(probe(200), probe(404))).toEqual({ ok: false, reason: "status_differs" });
    expect(judgeProbe(probe(301), probe(200))).toEqual({ ok: false, reason: "status_differs" });
  });
  it("a redirect that Coolify also served passes", () => {
    expect(judgeProbe(probe(301, H("a")), probe(301, H("a")))).toEqual({ ok: true, reason: "ok" });
  });
  it("no answer and a server error fail", () => {
    expect(judgeProbe(probe(200), probe(null, null, null))).toEqual({ ok: false, reason: "unreachable" });
    expect(judgeProbe(probe(200), probe(502))).toEqual({ ok: false, reason: "server_error" });
    expect(judgeProbe(probe(200), undefined)).toEqual({ ok: false, reason: "no_answer" });
  });
  it("an app already failing at Coolify passes only when it fails the same way, and a different failure does not", () => {
    expect(judgeProbe(probe(502), probe(502))).toEqual({ ok: true, reason: "preexisting" });
    expect(judgeProbe(probe(502), probe(503))).toEqual({ ok: false, reason: "server_error" });
    expect(judgeProbe(probe(502), probe(200))).toEqual({ ok: true, reason: "ok" });
  });
  it("an app Coolify did not answer for passes when Tugra answers without an error", () => {
    expect(judgeProbe(probe(null, null, null), probe(200))).toEqual({ ok: true, reason: "ok" });
    expect(judgeProbe(undefined, probe(500))).toEqual({ ok: false, reason: "server_error" });
  });
});

describe("mapMounts", () => {
  const app = { id: "app1", volumes: [{ name: "data", path: "/data" }], hostMounts: [{ hostPath: "/srv/media", containerPath: "/media" }] };
  it("a Coolify volume becomes an alias of the Tugra volume declared for that path, and the app is exclusive", () => {
    const r = mapMounts({ mounts: [{ type: "volume", source: "abc-data", destination: "/data", rw: true }] }, app);
    expect(r).toEqual({ volumes: [{ from: "abc-data", to: "tugra_appv_app1_data" }], binds: 0, exclusive: true, issues: [] });
  });
  it("a bind mount declared on the Tugra app counts and makes the app exclusive", () => {
    const r = mapMounts({ mounts: [{ type: "bind", source: "/srv/media", destination: "/media", rw: true }] }, app);
    expect(r).toEqual({ volumes: [], binds: 1, exclusive: true, issues: [] });
  });
  it("a writable volume or bind with no counterpart is an issue", () => {
    expect(mapMounts({ mounts: [{ type: "volume", source: "abc-x", destination: "/other", rw: true }] }, app).issues).toEqual(["volume_unmapped"]);
    expect(mapMounts({ mounts: [{ type: "bind", source: "/srv/x", destination: "/x", rw: true }] }, app).issues).toEqual(["bind_unmapped"]);
  });
  it("a read-only mount with no counterpart is not an issue, and a read-only one with a counterpart does not make the app exclusive", () => {
    expect(mapMounts({ mounts: [{ type: "bind", source: "/etc/x", destination: "/x", rw: false }] }, app)).toEqual({ volumes: [], binds: 0, exclusive: false, issues: [] });
    expect(mapMounts({ mounts: [{ type: "volume", source: "abc-data", destination: "/data", rw: false }] }, app).exclusive).toBe(false);
  });
  it("an app with no mounts runs alongside Coolify's copy", () => {
    expect(mapMounts({ mounts: [{ type: "tmpfs", source: "", destination: "/tmp", rw: true }] }, app).exclusive).toBe(false);
  });
  it("the same issue is reported once", () => {
    expect(mapMounts({ mounts: [{ type: "volume", source: "a", destination: "/p", rw: true }, { type: "volume", source: "b", destination: "/q", rw: true }] }, app).issues).toEqual(["volume_unmapped"]);
  });
});

describe("state machines", () => {
  it("every status is reachable on the way up and a give-back is possible from every started one", () => {
    const path: TakeoverStatus[] = ["PLANNED", "TESTING", "SWAPPING", "SWAPPED", "VERIFIED"];
    for (let i = 0; i < path.length - 1; i++) expect(canTakeoverTransition(path[i], path[i + 1])).toBe(true);
    for (const s of TAKEOVER_STATUSES) expect(canGiveBack(s)).toBe(s !== "GIVEN_BACK" && s !== "GIVING_BACK");
  });
  it("cannot skip the test, cannot leave a given-back takeover and cannot go from planned straight to swapped", () => {
    expect(canTakeoverTransition("PLANNED", "SWAPPING")).toBe(false);
    expect(canTakeoverTransition("PLANNED", "SWAPPED")).toBe(false);
    expect(canTakeoverTransition("GIVEN_BACK", "TESTING")).toBe(false);
    expect(canTakeoverTransition("GIVING_BACK", "SWAPPED")).toBe(false);
  });
  it("a failed takeover may be tested again or given back", () => {
    expect(canTakeoverTransition("FAILED", "TESTING")).toBe(true);
    expect(canTakeoverTransition("FAILED", "GIVING_BACK")).toBe(true);
  });
  it("Tugra's proxy may own the ports from the swap on", () => {
    expect(TAKEOVER_STATUSES.filter(portsMayBeTugras)).toEqual(["SWAPPING", "SWAPPED", "VERIFIED", "GIVING_BACK", "FAILED"]);
  });
  it("a certificate goes pending, fallback, then issued; a failed attempt can be retried; issued is final", () => {
    expect(canCertTransition("pending", "fallback")).toBe(true);
    expect(canCertTransition("fallback", "issued")).toBe(true);
    expect(canCertTransition("fallback", "failed")).toBe(true);
    expect(canCertTransition("failed", "fallback")).toBe(true);
    for (const s of TAKEOVER_CERT_STATES) if (s !== "issued") expect(canCertTransition("issued", s)).toBe(false);
    expect(canCertTransition("pending", "pending")).toBe(true);
  });
});

function item(o: Partial<TakeoverItem> & { itemRef: string }): TakeoverItem {
  return {
    name: o.itemRef,
    buildMode: "reuse-image",
    domains: [{ host: `${o.itemRef}.example.com`, tempCheck: "ok", finalCheck: "pending", cert: "pending" }],
    appId: "app-" + o.itemRef,
    uuid: "uuid-" + o.itemRef,
    commitSha: null,
    container: { id: H("a"), name: "x-1", image: "x:1", restart: "unless-stopped", imageId: "sha256:" + H("b") },
    volumes: [],
    binds: 0,
    exclusive: false,
    adoptDeploymentId: null,
    adoptTag: null,
    rebuildDeploymentId: null,
    state: "prepared",
    issues: [],
    baseline: {},
    fallbackSerial: {},
    fallbackAt: {},
    certAttempts: {},
    ...o,
  };
}

describe("swapGate", () => {
  it("passes when every item is prepared and every domain of a side-by-side item passed", () => {
    expect(swapGate([item({ itemRef: "a" }), item({ itemRef: "b" })])).toEqual({ ok: true });
  });
  it("refuses nothing to take over", () => {
    expect(swapGate([])).toEqual({ ok: false, code: "no_items" });
    expect(swapGate([item({ itemRef: "a", state: "skipped" })])).toEqual({ ok: false, code: "no_items" });
  });
  it("refuses an item that is not prepared", () => {
    expect(swapGate([item({ itemRef: "a", state: "planned" })])).toEqual({ ok: false, code: "item_not_ready", itemRef: "a" });
  });
  it("refuses a failed or untested domain, naming it", () => {
    expect(swapGate([item({ itemRef: "a", domains: [{ host: "a.example.com", tempCheck: "failed", finalCheck: "pending", cert: "pending" }] })])).toEqual({ ok: false, code: "test_failed", itemRef: "a", host: "a.example.com" });
    expect(swapGate([item({ itemRef: "a", domains: [{ host: "a.example.com", tempCheck: "pending", finalCheck: "pending", cert: "pending" }] })])).toEqual({ ok: false, code: "not_tested", itemRef: "a", host: "a.example.com" });
  });
  it("an exclusive item is not held up for a test it cannot have, but must be prepared", () => {
    const pending = [{ host: "a.example.com", tempCheck: "pending" as const, finalCheck: "pending" as const, cert: "pending" as const }];
    expect(swapGate([item({ itemRef: "a", exclusive: true, domains: pending })])).toEqual({ ok: true });
    expect(swapGate([item({ itemRef: "a", exclusive: true, domains: pending, state: "planned" })])).toMatchObject({ ok: false, code: "item_not_ready" });
  });
  it("a skipped item is ignored, even with a failed domain", () => {
    expect(swapGate([item({ itemRef: "a" }), item({ itemRef: "b", state: "skipped", domains: [{ host: "b.example.com", tempCheck: "failed", finalCheck: "pending", cert: "pending" }] })])).toEqual({ ok: true });
  });
});

describe("verified, domains and views", () => {
  it("is verified only when every domain passed its final check and holds a new certificate", () => {
    const ok = { host: "a.example.com", tempCheck: "ok" as const, finalCheck: "ok" as const, cert: "issued" as const };
    expect(isVerified([item({ itemRef: "a", domains: [ok] })])).toBe(true);
    expect(isVerified([item({ itemRef: "a", domains: [{ ...ok, cert: "fallback" }] })])).toBe(false);
    expect(isVerified([item({ itemRef: "a", domains: [{ ...ok, finalCheck: "failed" }] })])).toBe(false);
    expect(isVerified([item({ itemRef: "a", domains: [ok] }), item({ itemRef: "b", domains: [{ ...ok, cert: "failed" }] })])).toBe(false);
    expect(isVerified([])).toBe(false);
  });
  it("lists the domains of the apps that take part", () => {
    expect(domainsOf([item({ itemRef: "a" }), item({ itemRef: "b", state: "skipped" })])).toEqual([{ itemRef: "a", host: "a.example.com" }]);
  });
  it("the view carries no uuid, container id, tag, baseline or serial", () => {
    const v = JSON.stringify(toItemView(item({ itemRef: "a", adoptTag: "tugra_x:y", baseline: { h: { status: 200, hash: H("a"), hash2: H("a") } }, fallbackSerial: { h: "0A" } })));
    expect(v).not.toMatch(/uuid|tugra_x|0A|"id"|sha256/);
    expect(JSON.parse(v)).toEqual({ itemRef: "a", name: "a", buildMode: "reuse-image", domains: [{ host: "a.example.com", tempCheck: "ok", finalCheck: "pending", cert: "pending" }] });
  });
  it("the adopted tag is the one the rollback path runs, and a commit is only kept when it is hex", () => {
    expect(adoptTagFor("app1", "dep9")).toBe("tugra_app1:dep9");
    expect(cleanCommit("abc1234")).toBe("abc1234");
    expect(cleanCommit("HEAD; rm -rf /")).toBeNull();
    expect(cleanCommit(null)).toBeNull();
  });
});

describe("overdueFallbacks and certWorkLeft", () => {
  const at = new Date("2026-11-26T12:00:00Z");
  const ago = (ms: number) => new Date(at.getTime() - ms).toISOString();
  const sw = (o: Partial<TakeoverItem>) => item({ itemRef: "a", state: "switched", ...o });
  it("flags a domain that served the fallback past the limit, measured from the FIRST time it was served", () => {
    expect(overdueFallbacks([sw({ fallbackAt: { "a.example.com": ago(60_000) }, fallbackSince: { "a.example.com": ago(FALLBACK_MAX_MS + 1000) } })], at)).toEqual(["a.example.com"]);
    expect(overdueFallbacks([sw({ fallbackAt: { "a.example.com": ago(FALLBACK_MAX_MS - 1000) } })], at)).toEqual([]);
  });
  it("ignores an issued domain, a domain that never had a fallback and an app that is not switched", () => {
    expect(overdueFallbacks([sw({ domains: [{ host: "a.example.com", tempCheck: "ok", finalCheck: "ok", cert: "issued" }], fallbackAt: { "a.example.com": ago(FALLBACK_MAX_MS * 3) } })], at)).toEqual([]);
    expect(overdueFallbacks([sw({})], at)).toEqual([]);
    expect(overdueFallbacks([sw({ state: "prepared", fallbackAt: { "a.example.com": ago(FALLBACK_MAX_MS * 3) } })], at)).toEqual([]);
  });
  it("work is left while a domain has attempts left, and not once they are used", () => {
    expect(certWorkLeft([sw({})])).toBe(true);
    expect(certWorkLeft([sw({ certAttempts: { "a.example.com": 3 } })])).toBe(false);
    expect(certWorkLeft([sw({ domains: [{ host: "a.example.com", tempCheck: "ok", finalCheck: "ok", cert: "issued" }] })])).toBe(false);
  });
});

describe("mapDbMounts", () => {
  const db = { id: "db1", dataMount: "/var/lib/postgresql/data", volumes: [{ name: "ext", path: "/ext" }] };
  const vol = (source: string, destination: string, rw = true) => ({ type: "volume" as const, source, destination, rw });
  it("the volume at the engine's data directory becomes an alias of the database's own data volume, an extra volume one of its extra volume", () => {
    expect(mapDbMounts({ mounts: [vol("coolify-data", "/var/lib/postgresql/data"), vol("coolify-ext", "/ext")] }, db)).toEqual({
      volumes: [
        { from: "coolify-data", to: "tugra_dbv_db1" },
        { from: "coolify-ext", to: "tugra_dbv_db1_ext" },
      ],
      issues: [],
    });
  });
  it("a data directory that is a bind mount, read-only or not mounted at all keeps the database out", () => {
    expect(mapDbMounts({ mounts: [{ type: "bind", source: "/srv/pg", destination: "/var/lib/postgresql/data", rw: true }] }, db).issues).toEqual(["db_volume_unmapped"]);
    expect(mapDbMounts({ mounts: [vol("c", "/var/lib/postgresql/data", false)] }, db).issues).toEqual(["db_volume_unmapped"]);
    expect(mapDbMounts({ mounts: [] }, db).issues).toEqual(["db_volume_unmapped"]);
  });
  it("a writable mount Tugra's database does not declare keeps it out; a read-only one and a tmpfs do not", () => {
    expect(mapDbMounts({ mounts: [vol("c", "/var/lib/postgresql/data"), vol("x", "/unknown")] }, db).issues).toEqual(["db_volume_unmapped"]);
    expect(mapDbMounts({ mounts: [vol("c", "/var/lib/postgresql/data"), vol("x", "/unknown", false), { type: "tmpfs", source: "", destination: "/run", rw: true }] }, db)).toMatchObject({ issues: [] });
  });
});

describe("sameImageRef", () => {
  it("spells images the way docker does", () => {
    expect(sameImageRef("postgres:16", "docker.io/library/postgres:16")).toBe(true);
    expect(sameImageRef("redis", "redis:latest")).toBe(true);
    expect(sameImageRef("Postgres:16-Alpine", "postgres:16-alpine")).toBe(true);
    expect(sameImageRef("postgres:16", "postgres:17")).toBe(false);
    expect(sameImageRef("postgres:16", "ghcr.io/x/postgres:16")).toBe(false);
    expect(sameImageRef("a@sha256:" + "a".repeat(64), "a@sha256:" + "b".repeat(64))).toBe(false);
  });
});

describe("a takeover with databases", () => {
  const base = { itemRef: "database:s:d", name: "main", buildMode: "reuse-image" as const, domains: [], appId: "db1", uuid: "d", commitSha: null, container: null, volumes: [], binds: 0, exclusive: true, adoptDeploymentId: null, adoptTag: null, rebuildDeploymentId: null, issues: [], baseline: {}, fallbackSerial: {}, fallbackAt: {}, certAttempts: {} };
  const dbItem = (o: Partial<TakeoverItem> = {}): TakeoverItem => ({ ...base, kind: "database", state: "switched", verify: { level: "counts", state: "ok" }, ...o });
  it("is verified only when the database was checked, whatever the domains say", () => {
    expect(isVerified([dbItem()])).toBe(true);
    expect(isVerified([dbItem({ verify: { level: "counts", state: "pending" } })])).toBe(false);
    expect(isVerified([dbItem({ verify: { level: "alive", state: "failed" } })])).toBe(false);
  });
  it("the gate does not ask a test of an app that starts after its database", () => {
    const app: TakeoverItem = { ...base, kind: undefined, itemRef: "app:s:a", name: "a", appId: "a1", exclusive: false, afterSwitch: true, state: "prepared", domains: [{ host: "a.example.com", tempCheck: "pending", finalCheck: "pending", cert: "pending" }] };
    expect(swapGate([dbItem({ state: "prepared" }), app])).toEqual({ ok: true });
    expect(swapGate([dbItem({ state: "prepared" }), { ...app, afterSwitch: false }])).toMatchObject({ ok: false, code: "not_tested" });
  });
  it("the screen sees the kind, the check level and state, and the after-switch flag, and no id, container or fingerprint", () => {
    const v = toItemView(dbItem({ container: { id: H("a"), name: "n", image: "i", restart: "no", imageId: "sha256:" + H("b") }, dbBefore: { level: "counts", state: "ok", tables: 1, rows: 2, hash: H("c") }, engine: "POSTGRES" }));
    expect(v).toMatchObject({ kind: "database", verify: { level: "counts", state: "ok" }, exclusive: true });
    expect(JSON.stringify(v)).not.toMatch(/dbBefore|container|imageId|sha256|fingerprint|appId|uuid/);
    expect(toItemView({ ...dbItem(), kind: undefined, afterSwitch: true, verify: undefined })).toMatchObject({ afterSwitch: true });
  });
});


describe("services: containers, start and stop order, verified", () => {
  const rec = (service: string, id: string, engine?: "POSTGRES") => ({
    service,
    container: { id: H(id), name: `${service}-u`, image: `${service}:1`, restart: "always" as const, imageId: "sha256:" + H("b") },
    composeImage: `${service}:1`,
    volumes: [],
    binds: [],
    ...(engine ? { engine } : {}),
    ready: "ok" as const,
    ...(engine ? { dbVerify: { level: "counts" as const, state: "ok" as const } } : {}),
  });
  // in start order: the database first, then what needs it
  const svc = (o: Partial<TakeoverItem> = {}): TakeoverItem => item({ itemRef: "service:s:u", kind: "service", container: null, members: [rec("db", "1", "POSTGRES"), rec("cache", "2"), rec("web", "3")], ...o });
  it("ctrsOf lists the containers in start order and stopCtrs the reverse, so dependents stop first", () => {
    expect(ctrsOf(svc()).map((c) => c.name)).toEqual(["db-u", "cache-u", "web-u"]);
    expect(stopCtrs(svc()).map((c) => c.name)).toEqual(["web-u", "cache-u", "db-u"]);
  });
  it("stopCtrs splits a service into the database-like containers (stopped last) and the rest", () => {
    expect(stopCtrs(svc(), "rest").map((c) => c.name)).toEqual(["web-u", "cache-u"]);
    expect(stopCtrs(svc(), "db").map((c) => c.name)).toEqual(["db-u"]);
    // an app has no such split: everything is "rest", nothing is "db"
    expect(stopCtrs(item({ itemRef: "a" }), "rest")).toHaveLength(1);
    expect(stopCtrs(item({ itemRef: "a" }), "db")).toEqual([]);
  });
  it("every recorded container carries what the give-back needs: id, name, image and the restart policy it had", () => {
    expect(ctrsOf(svc())[0]).toEqual({ id: H("1"), name: "db-u", image: "db:1", restart: "always", ports: "", itemRef: "service:s:u" });
    expect(hasCtrs(svc())).toBe(true);
    expect(hasCtrs(item({ itemRef: "a", container: null }))).toBe(false);
  });
  it("is verified only when every member is ready and every database-like member answered the same, besides the domains", () => {
    const ok = { host: "a.example.com", tempCheck: "ok" as const, finalCheck: "ok" as const, cert: "issued" as const };
    const good = svc({ domains: [ok], state: "switched" });
    expect(membersVerified(good)).toBe(true);
    expect(isVerified([good])).toBe(true);
    const unready = svc({ domains: [ok], members: [rec("db", "1", "POSTGRES"), { ...rec("web", "3"), ready: "failed" }] });
    expect(isVerified([unready])).toBe(false);
    const unchecked = svc({ domains: [ok], members: [{ ...rec("db", "1", "POSTGRES"), dbVerify: { level: "counts", state: "failed" } }] });
    expect(isVerified([unchecked])).toBe(false);
    expect(isVerified([svc({ domains: [{ ...ok, cert: "fallback" }] })])).toBe(false);
    expect(isVerified([svc({ domains: [], members: [] })])).toBe(false);
    // an internal service with no domain is verified by its members alone
    expect(isVerified([svc({ domains: [] })])).toBe(true);
  });
  it("the view of a service lists its members by name with their readiness and carries no container, image or id", () => {
    const v = JSON.stringify(toItemView(svc()));
    expect(JSON.parse(v)).toMatchObject({ kind: "service", members: [{ name: "db", ready: "ok", verify: { level: "counts", state: "ok" } }, { name: "cache", ready: "ok" }, { name: "web", ready: "ok" }] });
    expect(v).not.toMatch(/db-u|sha256|[0-9a-f]{64}|composeImage|restart/);
  });
});
