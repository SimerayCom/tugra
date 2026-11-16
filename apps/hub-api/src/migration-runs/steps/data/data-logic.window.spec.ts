import { ACME_BASE_SEC, ACME_PER_HOST_SEC, HEALTH_BASE_SEC, HEALTH_PROBE_PARALLEL, HEALTH_PROBE_SEC_ASSUMED, HUB_BYTE_FACTOR, estimateWindow, estimateWindowDetail, windowExtrasOf } from "./data-logic";
import { BUILD_SEC_ASSUMED, START_SEC_ASSUMED, deployWindow } from "../import/baseline/build-window";
import { NOW, inspected, makeRun, makeSnap } from "./testing/fakes";

const apps = (git: number, image: number) => [
  ...Array.from({ length: git }, (_, i) => ({ itemRef: `app:s:git${i}`, name: `git-${i}`, source: "GIT" as const })),
  ...Array.from({ length: image }, (_, i) => ({ itemRef: `app:s:img${i}`, name: `img-${i}`, source: "IMAGE" as const })),
];

describe("estimateWindow includes what happens after the data (R27/C5)", () => {
  it("without extras it is the data window alone (unchanged for callers that pass none)", () => {
    expect(estimateWindow(makeSnap({ apps: [] }), NOW).freezeToFlipSec).toBe(120);
    expect(estimateWindow(makeSnap({ apps: [] }), NOW).basis.map((b) => b.code)).not.toContain("data-seed.estimate.deploy");
  });

  it("adds the deploy window of the git builds and every app start, the health gates and the ACME issuance", () => {
    const snap = makeSnap({ apps: apps(3, 1) });
    const run = makeRun();
    const extras = windowExtrasOf(run, snap);
    expect(extras.deploy).toEqual({ builds: 3, starts: 4, concurrency: 1, targets: 1 });
    expect(extras.hosts).toBe(4);
    const { estimate, terms } = estimateWindowDetail(snap, NOW, extras);
    const w = deployWindow(extras.deploy!);
    expect(terms.buildSec).toBe(3 * BUILD_SEC_ASSUMED);
    expect(terms.startSec).toBe(4 * START_SEC_ASSUMED);
    expect(terms.healthSec).toBe(HEALTH_BASE_SEC + Math.ceil(4 / HEALTH_PROBE_PARALLEL) * HEALTH_PROBE_SEC_ASSUMED);
    expect(terms.acmeSec).toBe(ACME_BASE_SEC + 4 * ACME_PER_HOST_SEC);
    expect(estimate.freezeToFlipSec).toBe(120 + w.totalSec + terms.healthSec + terms.acmeSec);
    expect(estimate.freezeToFlipSec).toBeGreaterThan(estimateWindow(snap, NOW).freezeToFlipSec!); // the old estimate left all of this out
    expect(estimate.basis.map((b) => b.code)).toEqual(expect.arrayContaining(["data-seed.estimate.deploy", "data-seed.estimate.health-acme"]));
    expect(estimate.basis.find((b) => b.code === "data-seed.estimate.deploy")).toMatchObject({ params: { builds: 3, starts: 4, buildSeconds: 720, startSeconds: 100 } });
  });

  it("the build concurrency and the number of target servers shorten the builds, earlyBuild removes them from the window", () => {
    const snap = makeSnap({ apps: apps(4, 0) });
    const serial = estimateWindowDetail(snap, NOW, windowExtrasOf(makeRun(), snap)).terms.buildSec;
    expect(serial).toBe(4 * BUILD_SEC_ASSUMED);
    const concurrent = estimateWindowDetail(snap, NOW, windowExtrasOf(makeRun({ options: { deployConcurrency: 2 } }), snap)).terms.buildSec;
    expect(concurrent).toBe(2 * BUILD_SEC_ASSUMED);
    const twoTargets = estimateWindowDetail(snap, NOW, windowExtrasOf(makeRun({ serverMap: { "host-a": "tgt-2" } }), snap)).terms.buildSec;
    expect(twoTargets).toBe(2 * BUILD_SEC_ASSUMED); // the default target and tgt-2
    const early = windowExtrasOf(makeRun({ options: { deployWaves: "earlyBuild" } }), snap);
    expect(early.deploy!.builds).toBe(0);
    const t = estimateWindowDetail(snap, NOW, early).terms;
    expect(t.buildSec).toBe(0);
    expect(t.startSec).toBe(4 * START_SEC_ASSUMED); // starting what was built early still costs
  });

  it("an app whose build source is not known is not counted as a build (no evidence), but every app still starts", () => {
    const snap = makeSnap({ apps: [{ itemRef: "app:s:x", name: "x" }] });
    expect(windowExtrasOf(makeRun(), snap).deploy).toMatchObject({ builds: 0, starts: 1 });
  });

  it("an unknown volume size still makes the whole estimate unknown, with or without extras", () => {
    const snap = makeSnap({ apps: apps(1, 0), volumes: [{ ...inspected("v"), inventory: null, rawBytesTotal: null }] });
    expect(estimateWindow(snap, NOW, windowExtrasOf(makeRun(), snap)).freezeToFlipSec).toBeNull();
  });
});

describe("estimateWindow shows the 2x hub bytes (R38)", () => {
  it("every copied byte crosses the hub twice; volumes and streamed dumps both count", () => {
    const gib = 1024 ** 3;
    const snap = makeSnap({
      apps: [],
      volumes: [inspected("volume:s:a:data", 3 * gib), { ...inspected("volume:s:db:dump", 2 * gib), destType: "db-dump" as const, engine: "POSTGRES" }],
    });
    const { estimate, terms } = estimateWindowDetail(snap, NOW);
    expect(HUB_BYTE_FACTOR).toBe(2);
    expect(terms.bytes).toBe(5 * gib);
    expect(terms.hubBytes).toBe(10 * gib);
    expect(estimate.basis.find((b) => b.code === "data-seed.estimate.hub-bytes")).toEqual({ code: "data-seed.estimate.hub-bytes", params: { bytes: 10 * gib, factor: 2 } });
  });
});
