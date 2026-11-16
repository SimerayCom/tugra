import { DIGEST_RE, floatingImages, imageRepoOf, isFloatingImage, pinFor, pinnedImageRef, serverRefOfItem } from "./image-pins";
import { InMemoryRunHints, PrismaRunHints, mergeHints, type RunHint } from "./run-hints";
import { baselineEntryOf, baselineItemRef, baselineVerdict, buildSourceBaseline, degradedItemRefs, isDegradedAtSource, preExistingHosts, sameBaseline, verdictOf } from "./source-health";
import { BUILD_SEC_ASSUMED, START_SEC_ASSUMED, deployWindow } from "./build-window";
import { isWorker, markConflicts, workerMarks, workerSets } from "./workers";

const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;
const pin = (key: string, value: string, scope = ""): RunHint => ({ kind: "image-pin", key, scope, value, evidence: "operator-attested" });
const mark = (key: string, value: string): RunHint => ({ kind: "worker-mark", key, scope: "", value, evidence: "operator-attested" });

describe("image pins (R11)", () => {
  it("floating = no tag, :latest, and no digest", () => {
    expect(isFloatingImage("getmeili/meilisearch:latest")).toBe(true);
    expect(isFloatingImage("gotenberg/gotenberg")).toBe(true);
    expect(isFloatingImage("registry.example.test:5000/team/app")).toBe(true);
    expect(isFloatingImage("postgres:18-alpine")).toBe(false);
    expect(isFloatingImage(`app/x@${D1}`)).toBe(false);
    expect(isFloatingImage(`app/x:latest@${D1}`)).toBe(false);
  });

  it("the repo keeps a registry port and drops tag and digest", () => {
    expect(imageRepoOf("registry.example.test:5000/team/app:latest")).toBe("registry.example.test:5000/team/app");
    expect(imageRepoOf(`team/app:1@${D1}`)).toBe("team/app");
    expect(imageRepoOf("team/app")).toBe("team/app");
  });

  it("pins a floating image to repo@digest, and never overrides a version tag, an existing digest or a malformed digest", () => {
    expect(pinnedImageRef("getmeili/meilisearch:latest", D1)).toBe(`getmeili/meilisearch@${D1}`);
    expect(pinnedImageRef("registry.example.test:5000/team/app", D2)).toBe(`registry.example.test:5000/team/app@${D2}`);
    expect(pinnedImageRef("getmeili/meilisearch:v1.31.0", D1)).toBeNull();
    expect(pinnedImageRef(`x/y@${D1}`, D2)).toBeNull();
    expect(pinnedImageRef("x/y:latest", "sha256:short")).toBeNull();
    expect(DIGEST_RE.test(D1)).toBe(true);
  });

  it("a server-specific pin wins over an every-server pin; a malformed value never counts", () => {
    const hints = [pin("img:latest", D1), pin("img:latest", D2, "srv-1"), pin("img:latest", "sha256:nope", "srv-2")];
    expect(pinFor(hints, "img:latest", "srv-1")).toBe(D2);
    expect(pinFor(hints, "img:latest", "srv-3")).toBe(D1);
    expect(pinFor(hints, "img:latest", "srv-2")).toBe(D1);
    expect(pinFor([], "img:latest", "srv-1")).toBeNull();
    expect(pinFor([mark("img:latest", "web")], "img:latest", "")).toBeNull();
  });

  it("parses the source server out of an itemRef", () => {
    expect(serverRefOfItem("app:srv-1:abc")).toBe("srv-1");
    expect(serverRefOfItem("app:_:abc")).toBe("");
    expect(serverRefOfItem("garbage")).toBe("");
  });

  it("lists floating app images and service members, marking which are pinned", () => {
    const items = [
      { itemRef: "app:srv-1:a", kind: "app", name: "proxy", proposed: { source: "IMAGE", image: "img/proxy:latest" } },
      { itemRef: "app:srv-1:b", kind: "app", name: "pinned-tag", proposed: { source: "IMAGE", image: "img/other:1.2" } },
      { itemRef: "app:srv-1:c", kind: "app", name: "git-app", proposed: { source: "GIT", image: null } },
      { itemRef: "service:srv-1:s", kind: "service", name: "search", proposed: { imageFloating: ["meili", "side"] } },
    ] as never;
    const applyInput = { serviceChoices: { "service:srv-1:s": { pins: { meili: `getmeili/meilisearch@${D1}`, side: "x:latest" } } } } as never;
    const out = floatingImages(items, applyInput, [pin("img/proxy:latest", D2, "srv-1")]);
    expect(out).toEqual([
      { itemRef: "app:srv-1:a", name: "proxy", kind: "app", image: "img/proxy:latest", pinned: true },
      { itemRef: "service:srv-1:s", name: "search", kind: "service", member: "meili", pinned: true },
      { itemRef: "service:srv-1:s", name: "search", kind: "service", member: "side", pinned: false },
    ]);
    expect(floatingImages(items, { serviceChoices: { "service:srv-1:s": { pinImages: false, pins: { meili: `getmeili/meilisearch@${D1}` } } } } as never, [])[1]).toMatchObject({ member: "meili", pinned: false });
  });
});

describe("workers (R26/C13)", () => {
  const input = { mapping: { items: { "app:_:peer": { containerAlias: "peer.internal" } } } } as never;
  const none = new Map();

  it("an app with no domain is a worker; an unknown domain, a domain, a mapped alias or a web mark is not", () => {
    expect(isWorker({ itemRef: "app:_:w", kind: "app", domain: null }, input, none)).toBe(true);
    expect(isWorker({ itemRef: "app:_:w", kind: "app", domain: undefined }, input, none)).toBe(false);
    expect(isWorker({ itemRef: "app:_:w", kind: "app", domain: "w.example.test" }, input, none)).toBe(false);
    expect(isWorker({ itemRef: "app:_:peer", kind: "app", domain: null }, input, none)).toBe(false);
    expect(isWorker({ itemRef: "app:_:w", kind: "app", domain: null }, input, workerMarks([mark("app:_:w", "web")]))).toBe(false);
    expect(isWorker({ itemRef: "database:_:d", kind: "database", domain: null }, input, none)).toBe(false);
  });

  it("a job-runner mark holds an app that has no domain of its own (an aliased internal one, or one the plan does not state a domain for)", () => {
    expect(isWorker({ itemRef: "app:_:peer", kind: "app", domain: null }, input, workerMarks([mark("app:_:peer", "job-runner")]))).toBe(true);
    expect(isWorker({ itemRef: "app:_:j", kind: "app", domain: undefined }, input, workerMarks([mark("app:_:j", "job-runner")]))).toBe(true);
    expect([...workerMarks([mark("app:_:j", "bogus"), pin("x", D1)]).keys()]).toEqual([]);
  });

  it("a job-runner mark on an app that serves a domain is a conflict, not a worker: a cutover host has to run dark", () => {
    const marks = workerMarks([mark("app:_:j", "job-runner"), mark("app:_:k", "job-runner"), mark("app:_:m", "web")]);
    const cands = [
      { itemRef: "app:_:j", kind: "app", domain: "j.example.test" },
      { itemRef: "app:_:k", kind: "app", domain: null },
      { itemRef: "app:_:m", kind: "app", domain: "m.example.test" },
    ];
    expect(isWorker(cands[0], input, marks)).toBe(false);
    expect(markConflicts(cands, marks).map((c) => c.itemRef)).toEqual(["app:_:j"]);
    expect(workerSets(cands, input, marks, "hold-dark").held).toEqual(new Set(["app:_:k"]));
  });

  it("the policy decides where workers go: hold-dark holds, exclude excludes, start-dark treats them as ordinary apps", () => {
    const cands = [
      { itemRef: "app:_:w", kind: "app", domain: null },
      { itemRef: "app:_:web", kind: "app", domain: "web.example.test" },
    ];
    expect(workerSets(cands, input, none, "hold-dark")).toEqual({ held: new Set(["app:_:w"]), excluded: new Set() });
    expect(workerSets(cands, input, none, "exclude")).toEqual({ held: new Set(), excluded: new Set(["app:_:w"]) });
    expect(workerSets(cands, input, none, "start-dark")).toEqual({ held: new Set(), excluded: new Set() });
  });
});

describe("source health baseline (R28/R52/R66)", () => {
  const rows = [
    { kind: "app" as const, ref: "r1", serverRef: "s1", health: "healthy" as const, restartCount: 0 },
    { kind: "app" as const, ref: "r2", serverRef: "s1", health: "exited" as const, restartCount: 90001 },
    { kind: "app" as const, ref: "r3", health: "unknown" as const, restartCount: 3 },
    { kind: "app" as const, ref: "r4", health: "unknown" as const, restartCount: 40 },
    { kind: "database" as const, ref: "d1", serverRef: "s2", health: "unhealthy" as const, restartCount: null },
  ];
  const now = new Date("2026-11-20T10:00:00.000Z");

  it("builds a stable, de-duplicated baseline and compares it ignoring the capture time", () => {
    const a = buildSourceBaseline([...rows, rows[0]], now);
    expect(a.entries).toHaveLength(5);
    expect(a.capturedAt).toBe(now.toISOString());
    const b = buildSourceBaseline([...rows].reverse(), new Date(now.getTime() + 5000));
    expect(sameBaseline(a, b)).toBe(true);
    expect(sameBaseline(null, b)).toBe(false);
    expect(sameBaseline(a, buildSourceBaseline(rows.slice(1), now))).toBe(false);
  });

  it("degraded = unhealthy, exited, or restarting a lot without being healthy; a few historic restarts are not", () => {
    const b = buildSourceBaseline(rows, now);
    const by = Object.fromEntries(b.entries.map((e) => [e.ref, isDegradedAtSource(e)]));
    expect(by).toEqual({ r1: false, r2: true, r3: false, r4: true, d1: true });
    expect([...degradedItemRefs(b)].sort()).toEqual(["app:_:r4", "app:s1:r2", "database:s2:d1"]);
    expect(degradedItemRefs(null).size).toBe(0);
    expect(baselineItemRef({ kind: "app", ref: "x" })).toBe("app:_:x");
  });

  it("judges Tugra against the source: a failure the source already had is pre-existing, a new one is a regression, no baseline excuses nothing", () => {
    const b = buildSourceBaseline(rows, now);
    const e = (ref: string) => b.entries.find((x) => x.ref === ref);
    expect(baselineVerdict(e("r2"), true)).toBe("healthy");
    expect(baselineVerdict(e("r2"), false)).toBe("pre-existing");
    expect(baselineVerdict(e("r1"), false)).toBe("regression");
    expect(baselineVerdict(e("r3"), false)).toBe("regression"); // unchecked at the source: no excuse
    expect(baselineVerdict(undefined, false)).toBe("unbaselined");
  });

  it("verdictOf looks the resource up by its plan itemRef: the one entry point VERIFY, CUTOVER and OBSERVE judge with", () => {
    const b = buildSourceBaseline(rows, now);
    expect(baselineEntryOf(b, "app:s1:r2")?.ref).toBe("r2");
    expect(baselineEntryOf(b, "app:other:r2")).toBeUndefined();
    expect(verdictOf(b, "app:s1:r2", false)).toBe("pre-existing");
    expect(verdictOf(b, "app:s1:r2", true)).toBe("healthy");
    expect(verdictOf(b, "app:s1:r1", false)).toBe("regression");
    expect(verdictOf(b, "app:_:never-seen", false)).toBe("unbaselined");
    expect(verdictOf(b, null, false)).toBe("unbaselined");
    expect(verdictOf(null, "app:s1:r2", false)).toBe("unbaselined");
  });

  it("preExistingHosts excuses only the failing hosts whose app was degraded at the source", () => {
    const b = buildSourceBaseline(rows, now);
    const appOf = (h: string) => ({ "r2.example.test": "app:s1:r2", "r1.example.test": "app:s1:r1" })[h] ?? null;
    expect([...preExistingHosts(b, ["r2.example.test", "r1.example.test", "mystery.example.test"], appOf)]).toEqual(["r2.example.test"]);
    expect(preExistingHosts(null, ["r2.example.test"], appOf).size).toBe(0);
  });
});

describe("deploy window (R27/C5)", () => {
  it("builds queue per target server at the configured concurrency; starts are cheap", () => {
    expect(deployWindow({ builds: 74, starts: 74, concurrency: 1, targets: 1 })).toEqual({ buildSec: 74 * BUILD_SEC_ASSUMED, startSec: 74 * START_SEC_ASSUMED, totalSec: 74 * (BUILD_SEC_ASSUMED + START_SEC_ASSUMED) });
    expect(deployWindow({ builds: 74, starts: 74, concurrency: 2, targets: 3 }).buildSec).toBe(13 * BUILD_SEC_ASSUMED);
    expect(deployWindow({ builds: 0, starts: 10, concurrency: 1, targets: 1 }).buildSec).toBe(0);
    expect(deployWindow({ builds: 5, starts: 5, concurrency: 99, targets: 1 }).buildSec).toBe(1 * BUILD_SEC_ASSUMED); // clamped to 8 slots
    expect(deployWindow({ builds: -3, starts: 0, concurrency: 0, targets: 0 })).toEqual({ buildSec: 0, startSec: 0, totalSec: 0 });
  });
});

describe("run hints store", () => {
  it("a promoted run reads its dry-run's hints and its own win", async () => {
    const s = new InMemoryRunHints();
    await s.upsert("dry", [pin("img:latest", D1), mark("app:_:w", "job-runner")]);
    await s.upsert("real", [pin("img:latest", D2)]);
    const merged = await s.list("real", "dry");
    expect(merged.find((h) => h.kind === "image-pin")?.value).toBe(D2);
    expect(merged.find((h) => h.kind === "worker-mark")?.value).toBe("job-runner");
    expect(await s.list("real")).toHaveLength(1);
    await s.remove("real", [{ kind: "image-pin", key: "img:latest", scope: "" }]);
    expect(await s.list("real")).toHaveLength(0);
    expect(mergeHints([], [pin("a", D1)])).toHaveLength(1);
  });
});

describe("PrismaRunHints (the production store)", () => {
  function fake(rows: Record<string, Array<{ kind: string; key: string; scope: string; value: string; evidence: string }>>) {
    const upsert = jest.fn((a: unknown) => a);
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const findMany = jest.fn(async ({ where }: { where: { runId: string } }) => rows[where.runId] ?? []);
    const $transaction = jest.fn(async (ops: unknown[]) => ops);
    return { prisma: { migrationRunHint: { findMany, upsert, deleteMany }, $transaction }, upsert, deleteMany, findMany, $transaction };
  }

  it("lists a run's hints, with its parent's merged under them, and bounds the read", async () => {
    const f = fake({
      real: [{ kind: "image-pin", key: "img:latest", scope: "", value: D2, evidence: "operator-attested" }],
      dry: [{ kind: "image-pin", key: "img:latest", scope: "", value: D1, evidence: "operator-attested" }, { kind: "worker-mark", key: "app:s:q", scope: "", value: "job-runner", evidence: "operator-attested" }],
    });
    const store = new PrismaRunHints(f.prisma as never);
    expect((await store.list("real")).map((h) => h.value)).toEqual([D2]);
    expect((await store.list("real", "dry")).map((h) => h.value)).toEqual([D2, "job-runner"]);
    expect(f.findMany.mock.calls[0][0]).toMatchObject({ where: { runId: "real" }, take: 5000 });
  });

  it("upserts in one transaction keyed by the whole primary key, and removes by exact key", async () => {
    const f = fake({});
    const store = new PrismaRunHints(f.prisma as never);
    await store.upsert("r1", [pin("img:latest", D1, "s1"), mark("app:s:q", "web")]);
    expect(f.$transaction).toHaveBeenCalledTimes(1);
    expect(f.upsert.mock.calls[0][0]).toMatchObject({ where: { runId_kind_key_scope: { runId: "r1", kind: "image-pin", key: "img:latest", scope: "s1" } }, create: { value: D1, evidence: "operator-attested" }, update: { value: D1 } });
    await store.remove("r1", [{ kind: "worker-mark", key: "app:s:q", scope: "" }]);
    expect(f.deleteMany).toHaveBeenCalledWith({ where: { runId: "r1", OR: [{ kind: "worker-mark", key: "app:s:q", scope: "" }] } });
    await store.upsert("r1", []);
    await store.remove("r1", []);
    expect(f.$transaction).toHaveBeenCalledTimes(1);
    expect(f.deleteMany).toHaveBeenCalledTimes(1);
  });
});
