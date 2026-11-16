import { EMPTY_STEP_EVIDENCE } from "../../core/run-contract";
import type { StepEvidence } from "../../core/dto";
import {
  HTTP01_GAP_ATTEST,
  LEFT_OUT_ATTEST,
  MANUAL_DNS_ATTEST,
  MANUAL_DNS_DEFER_ATTEST,
  MANUAL_DNS_STALE_MS,
  OBJECT_CLEARED_ATTEST,
  attestationFor,
  computeHolds,
  flipGroups,
  gapAccepted,
  isObjectStoreKey,
  manualAwaitingDns,
  manualToDo,
  objectDependants,
  objectStoreKeys,
  objectsVerified,
  type HoldApp,
  type HoldInput,
} from "./cutover-holds";
import type { Entry } from "./run-cutover-logic";

const NOW = new Date("2026-11-20T10:00:00Z");
const ev = (...a: Array<{ checkId: string; subject?: string; at?: string }>): StepEvidence => ({
  attestations: a.map((x) => ({ checkId: x.checkId, ...(x.subject ? { subject: x.subject } : {}), byUserId: "u1", at: x.at ?? NOW.toISOString() })),
  attachments: [],
});
const entry = (host: string, app: string, over: Partial<Entry> = {}): Entry => ({ hostname: host, applicationId: app, state: "READY", dnsMode: "cloudflare", challenge: "dns01", certState: "ready", blockReason: null, dnsObserved: "source", ...over }) as Entry;
const apps = (...a: HoldApp[]): Map<string, HoldApp> => new Map(a.map((x) => [x.appId, x]));
const app = (appId: string, over: Partial<HoldApp> = {}): HoldApp => ({ appId, kind: "app", status: "RUNNING", objectStore: false, ...over });

const base = (over: Partial<HoldInput> = {}): HoldInput => ({
  entries: [],
  apps: new Map(),
  objectKeys: new Map(),
  policy: "hold",
  objects: null,
  cutoverEvidence: EMPTY_STEP_EVIDENCE,
  tlsEvidence: EMPTY_STEP_EVIDENCE,
  acceptHttp01Gap: false,
  ...over,
});

describe("object store keys", () => {
  it.each(["S3_ENDPOINT", "AWS_S3_BUCKET", "MINIO_ROOT_USER", "BUCKET_NAME", "bucket", "OBJECT_STORAGE_URL", "OBJECTSTORAGE_HOST", "STORAGE_ENDPOINT", "STORAGE_URL", "STORAGE_HOST", "s3-region"])("%s points at an object store", (k) => {
    expect(isObjectStoreKey(k)).toBe(true);
  });

  it.each(["DATABASE_URL", "STORAGE_PATH", "STORAGE", "S3CRET", "BUCKETLIST_ENABLED", "PORT", "REDIS_HOST", "MINIOS"])("%s does not", (k) => {
    expect(isObjectStoreKey(k)).toBe(false);
  });

  it("lists the matching names sorted and once", () => {
    expect(objectStoreKeys(["PORT", "S3_ENDPOINT", "BUCKET", "S3_ENDPOINT"])).toEqual(["BUCKET", "S3_ENDPOINT"]);
  });
});

describe("objectsVerified", () => {
  it("needs an attached migration, selected buckets, all of them VERIFIED and no problem; unknown is not verified", () => {
    expect(objectsVerified(null)).toBe(false);
    expect(objectsVerified({ attached: 0, selectedBuckets: 0, verified: 0, problems: 0 })).toBe(false);
    expect(objectsVerified({ attached: 1, selectedBuckets: 0, verified: 0, problems: 0 })).toBe(false);
    expect(objectsVerified({ attached: 1, selectedBuckets: 3, verified: 2, problems: 0 })).toBe(false);
    expect(objectsVerified({ attached: 1, selectedBuckets: 3, verified: 3, problems: 1 })).toBe(false);
    expect(objectsVerified({ attached: 2, selectedBuckets: 3, verified: 3, problems: 0 })).toBe(true);
  });
});

describe("attestations are per host", () => {
  it("a subject attestation covers its host only; a subject-less one covers every host only where allowed", () => {
    const e = ev({ checkId: "x", subject: "A.example.test" }, { checkId: "g" });
    expect(attestationFor(e, "x", "a.example.test", false)).toEqual(NOW);
    expect(attestationFor(e, "x", "b.example.test", false)).toBeNull();
    expect(attestationFor(e, "g", "b.example.test", true)).toEqual(NOW);
    expect(attestationFor(e, "g", "b.example.test", false)).toBeNull();
  });

  it("the newest attestation wins", () => {
    const e = ev({ checkId: "x", subject: "h.example.test", at: "2026-11-20T09:00:00Z" }, { checkId: "x", subject: "h.example.test", at: "2026-11-20T09:30:00Z" });
    expect(attestationFor(e, "x", "h.example.test", false)).toEqual(new Date("2026-11-20T09:30:00Z"));
  });
});

describe("computeHolds", () => {
  const web = entry("web.example.test", "a1");
  const img = entry("img.example.test", "a2");

  it("hold (the default): object-storage dependants stay on the source, only they are named, with the names that say so", () => {
    const holds = computeHolds(base({ entries: [web, img], apps: apps(app("a1"), app("a2")), objectKeys: new Map([["a2", ["S3_ENDPOINT"]]]) }));
    expect([...holds.values()]).toEqual([{ hostname: "img.example.test", reason: "object-store-hold", kind: "skip", via: ["S3_ENDPOINT"] }]);
  });

  it("the object store service itself is a dependant of its own data", () => {
    const holds = computeHolds(base({ entries: [img], apps: apps(app("a2", { kind: "service", objectStore: true })), objectKeys: new Map([["a2", ["MINIO_ROOT_USER"]]]) }));
    expect(holds.get("img.example.test")).toMatchObject({ reason: "object-store-hold", via: ["object-store", "MINIO_ROOT_USER"] });
  });

  it("mirror: dependants wait until every selected bucket is verified, then flip; external: nothing is held", () => {
    const input = base({ entries: [web, img], apps: apps(app("a1"), app("a2")), objectKeys: new Map([["a2", ["S3_ENDPOINT"]]]), policy: "mirror" });
    expect(computeHolds(input).get("img.example.test")).toMatchObject({ reason: "objects-unverified", kind: "pending" });
    expect(computeHolds({ ...input, objects: { attached: 1, selectedBuckets: 2, verified: 1, problems: 0 } }).has("img.example.test")).toBe(true);
    expect(computeHolds({ ...input, objects: { attached: 1, selectedBuckets: 2, verified: 2, problems: 0 } }).size).toBe(0);
    expect(computeHolds({ ...input, policy: "external" }).size).toBe(0);
  });

  it("an attestation clears ONE host (the subject), never every host; a subject-less one clears nothing", () => {
    const input = base({ entries: [web, img], apps: apps(app("a1"), app("a2")), objectKeys: new Map([["a1", ["S3_BUCKET"]], ["a2", ["S3_ENDPOINT"]]]) });
    const cleared = computeHolds({ ...input, cutoverEvidence: ev({ checkId: OBJECT_CLEARED_ATTEST, subject: "img.example.test" }) });
    expect([...cleared.keys()]).toEqual(["web.example.test"]);
    expect(computeHolds({ ...input, cutoverEvidence: ev({ checkId: OBJECT_CLEARED_ATTEST }) }).size).toBe(2);
  });

  it("a compose service that is not running waits (it is created stopped); a running one flips", () => {
    expect(computeHolds(base({ entries: [web], apps: apps(app("a1", { kind: "service", status: "STOPPED" })) })).get("web.example.test")).toMatchObject({ reason: "service-not-running", kind: "pending" });
    expect(computeHolds(base({ entries: [web], apps: apps(app("a1", { kind: "service", status: "RUNNING" })) })).size).toBe(0);
    // an ordinary app is never held for its status (DEPLOY_DARK and VERIFY own that)
    expect(computeHolds(base({ entries: [web], apps: apps(app("a1", { status: "STOPPED" })) })).size).toBe(0);
  });

  it("an HTTP-01 host without a certificate waits for ITS acceptance (run option, host attestation on either step, or a global one)", () => {
    const gap = entry("gap.example.test", "a1", { challenge: "http01", certState: "pending" });
    const other = entry("other.example.test", "a1", { challenge: "http01", certState: "pending" });
    const input = base({ entries: [gap, other], apps: apps(app("a1")) });
    expect([...computeHolds(input).keys()].sort()).toEqual(["gap.example.test", "other.example.test"]);
    expect([...computeHolds({ ...input, acceptHttp01Gap: true }).keys()]).toEqual([]);
    expect([...computeHolds({ ...input, tlsEvidence: ev({ checkId: HTTP01_GAP_ATTEST, subject: "gap.example.test" }) }).keys()]).toEqual(["other.example.test"]);
    expect([...computeHolds({ ...input, cutoverEvidence: ev({ checkId: HTTP01_GAP_ATTEST, subject: "other.example.test" }) }).keys()]).toEqual(["gap.example.test"]);
    expect(computeHolds({ ...input, cutoverEvidence: ev({ checkId: HTTP01_GAP_ATTEST }) }).size).toBe(0);
    expect(gapAccepted({ hostname: "gap.example.test" }, false, EMPTY_STEP_EVIDENCE, EMPTY_STEP_EVIDENCE)).toBe(false);
  });

  it("a deferred manual-DNS host stays out for good; only a per-host deferral counts", () => {
    const man = entry("man.example.test", "a1", { dnsMode: "manual" });
    const input = base({ entries: [man], apps: apps(app("a1")) });
    expect(computeHolds({ ...input, cutoverEvidence: ev({ checkId: MANUAL_DNS_DEFER_ATTEST, subject: "man.example.test" }) }).get("man.example.test")).toMatchObject({ reason: "manual-dns-deferred", kind: "skip" });
    expect(computeHolds({ ...input, cutoverEvidence: ev({ checkId: MANUAL_DNS_DEFER_ATTEST }) }).size).toBe(0);
  });

  it("a host the operator leaves out stays on the source, whatever else is true of it; per host only, on either step", () => {
    const input = base({ entries: [web, img], apps: apps(app("a1"), app("a2")) });
    expect(computeHolds({ ...input, cutoverEvidence: ev({ checkId: LEFT_OUT_ATTEST, subject: "web.example.test" }) }).get("web.example.test")).toMatchObject({ reason: "host-left-out", kind: "skip" });
    expect(computeHolds({ ...input, tlsEvidence: ev({ checkId: LEFT_OUT_ATTEST, subject: "img.example.test" }) }).get("img.example.test")).toMatchObject({ reason: "host-left-out", kind: "skip" });
    expect(computeHolds({ ...input, cutoverEvidence: ev({ checkId: LEFT_OUT_ATTEST }) }).size).toBe(0);
  });

  it("hosts that already flipped (or are blocked) are never held", () => {
    const flipped = entry("done.example.test", "a2", { state: "VERIFIED" });
    const blocked = entry("blk.example.test", "a2", { state: "BLOCKED" });
    expect(computeHolds(base({ entries: [flipped, blocked], apps: apps(app("a2")), objectKeys: new Map([["a2", ["S3_ENDPOINT"]]]) })).size).toBe(0);
  });

  it("objectDependants names the dependants independent of the policy", () => {
    const d = objectDependants([web, img], apps(app("a1"), app("a2")), new Map([["a2", ["S3_ENDPOINT", "S3_BUCKET", "S3_KEY", "S3_SECRET", "S3_REGION", "S3_X"]]]));
    expect([...d]).toEqual([["img.example.test", ["S3_ENDPOINT", "S3_BUCKET", "S3_KEY", "S3_SECRET", "S3_REGION"]]]);
  });
});

describe("flipGroups", () => {
  const e = (host: string, app: string) => entry(host, app);
  const server = (m: Record<string, string>) => (x: Entry) => m[x.applicationId] ?? "";

  it("one group per target server in the run's server order, dependants last", () => {
    const hosts = [e("a.example.test", "a1"), e("b.example.test", "a2"), e("c.example.test", "a3"), e("d.example.test", "a1")];
    const dependants = new Map([["a.example.test", ["S3_ENDPOINT"]]]);
    const groups = flipGroups(hosts, server({ a1: "srv-1", a2: "srv-2", a3: "srv-2" }), dependants, ["srv-1", "srv-2"]);
    expect(groups).toEqual([
      { serverId: "srv-1", tier: 0, hosts: ["d.example.test"] },
      { serverId: "srv-2", tier: 0, hosts: ["b.example.test", "c.example.test"] },
      { serverId: "srv-1", tier: 1, hosts: ["a.example.test"] },
    ]);
  });

  it("a single target server with no dependants is ONE group (the classic flip)", () => {
    const groups = flipGroups([e("a.example.test", "a1"), e("b.example.test", "a2")], () => "srv-1", new Map(), ["srv-1"]);
    expect(groups).toEqual([{ serverId: "srv-1", tier: 0, hosts: ["a.example.test", "b.example.test"] }]);
  });

  it("an unknown server sorts after the known ones", () => {
    const groups = flipGroups([e("a.example.test", "a1"), e("b.example.test", "a2")], server({ a1: "srv-x", a2: "srv-1" }), new Map(), ["srv-1"]);
    expect(groups.map((g) => g.serverId)).toEqual(["srv-1", "srv-x"]);
  });
});

describe("manual DNS checklist", () => {
  const hosts = [entry("m1.example.test", "a1", { dnsMode: "manual" }), entry("m2.example.test", "a1", { dnsMode: "manual" }), entry("m3.example.test", "a1", { dnsMode: "manual" })];

  it("a host is to do until it is confirmed; a confirmation older than the window asks again", () => {
    const fresh = new Date(NOW.getTime() - 60_000).toISOString();
    const old = new Date(NOW.getTime() - MANUAL_DNS_STALE_MS - 1000).toISOString();
    const e = ev({ checkId: MANUAL_DNS_ATTEST, subject: "m1.example.test", at: fresh }, { checkId: MANUAL_DNS_ATTEST, subject: "m2.example.test", at: old });
    expect(manualToDo(hosts, e, NOW).map((m) => m.hostname)).toEqual(["m2.example.test", "m3.example.test"]);
    expect(manualAwaitingDns(hosts, e, NOW)).toEqual(["m1.example.test"]);
  });

  it("a subject-less confirmation covers every host (the old single button)", () => {
    const e = ev({ checkId: MANUAL_DNS_ATTEST });
    expect(manualToDo(hosts, e, NOW)).toEqual([]);
    expect(manualAwaitingDns(hosts, e, NOW)).toHaveLength(3);
  });
});
