import { describe, it, expect } from "vitest";
import { bucketPct, isLive, needsMergeAck, nextActions, overallPct, parseExcludes, sortBySize } from "./object-migration";
import { statusLabelKey, warningText } from "./object-migration-labels";
import type { ObjectBucketView, ObjectMigrationView } from "./types";

const b = (over: Partial<ObjectBucketView> = {}): ObjectBucketView => ({
  idx: 0, srcBucket: "bk", dstBucket: "bk", exclude: [], selected: false, status: "PENDING", srcObjects: null, srcBytes: null, dstObjects: null, dstBytes: null, doneObjects: null, doneBytes: null,
  diffMissing: null, diffDiffer: null, diffExtra: null, versioning: null, configSummary: null, configStatus: null, lastError: null, startedAt: null, finishedAt: null, ...over,
});
const m = (over: Partial<ObjectMigrationView> = {}, buckets: ObjectBucketView[] = []): ObjectMigrationView => ({
  id: "m1", name: "m", teamId: "t", targetServerId: "s", status: "PREFLIGHTED", phase: null, srcEndpoint: "https://a", dstEndpoint: "https://b", preserve: true, removeExtraneous: false, mergeIntoExisting: false,
  cancelRequested: false, warnings: [], buckets, canWrite: true, createdAt: "", updatedAt: "", finishedAt: null, ...over,
});

describe("sortBySize", () => {
  it("largest first, unknown sizes last, then by name; never mutates", () => {
    const input = [b({ srcBucket: "small", srcBytes: 10 }), b({ srcBucket: "big", srcBytes: 3_900_000_000 }), b({ srcBucket: "unknown" }), b({ srcBucket: "alpha", srcBytes: 10 })];
    const out = sortBySize(input);
    expect(out.map((x) => x.srcBucket)).toEqual(["big", "alpha", "small", "unknown"]);
    expect(input[0].srcBucket).toBe("small");
  });
});

describe("progress", () => {
  it("bucketPct: bytes first, then objects; finished states are 100; unknown is null", () => {
    expect(bucketPct(b({ status: "SEEDING", srcBytes: 200, doneBytes: 50 }))).toBe(25);
    expect(bucketPct(b({ status: "SEEDING", srcObjects: 10, doneObjects: 5 }))).toBe(50);
    expect(bucketPct(b({ status: "SEEDING", srcBytes: 100, doneBytes: 500 }))).toBe(100); // clamped
    expect(bucketPct(b({ status: "SEEDED" }))).toBe(100);
    expect(bucketPct(b({ status: "SEEDING" }))).toBeNull();
  });
  it("overallPct averages the SELECTED buckets and is null when any is unmeasurable", () => {
    expect(overallPct(m({}, [b({ selected: true, status: "SEEDED" }), b({ srcBucket: "b2", selected: true, status: "SEEDING", srcBytes: 100, doneBytes: 50 }), b({ srcBucket: "b3", status: "PENDING" })]))).toBe(75);
    expect(overallPct(m({}, [b({ selected: true, status: "SEEDING" })]))).toBeNull();
    expect(overallPct(m())).toBeNull();
  });
});

describe("nextActions / isLive", () => {
  it("DRAFT can only preflight; PREFLIGHTED with a selection can seed but not final", () => {
    expect(nextActions(m({ status: "DRAFT" }))).toMatchObject({ preflight: true, select: false, seed: false, final: false });
    expect(nextActions(m({}, [b({ selected: true })]))).toMatchObject({ seed: true, final: false, verify: false });
    expect(nextActions(m({}, [b()]))).toMatchObject({ seed: false }); // nothing selected
  });
  it("SEEDED allows final, verify, carry (with an exported config)", () => {
    const x = nextActions(m({ status: "SEEDED" }, [b({ selected: true, status: "SEEDED", configStatus: "EXPORTED" })]));
    expect(x).toMatchObject({ seed: true, final: true, verify: true, carry: true, cancel: false });
  });
  it("while a helper is live: only cancel; everything else is disabled", () => {
    const live = m({ status: "SEEDING" }, [b({ selected: true, status: "SEEDING" })]);
    expect(isLive(live)).toBe(true);
    expect(nextActions(live)).toEqual({ preflight: false, select: false, seed: false, final: false, verify: false, carry: false, cancel: true });
    expect(isLive(m({ status: "VERIFYING" }))).toBe(true);
  });
  it("a viewer (canWrite false) gets no actions", () => {
    expect(Object.values(nextActions(m({ canWrite: false, status: "SEEDED" }, [b({ selected: true, status: "SEEDED" })]))).every((v) => v === false)).toBe(true);
  });
});

describe("misc", () => {
  it("needsMergeAck only for selected, never-started buckets whose destination holds objects", () => {
    expect(needsMergeAck(m({}, [b({ selected: true, dstObjects: 4 })]))).toBe(true);
    expect(needsMergeAck(m({}, [b({ selected: true, dstObjects: 0 })]))).toBe(false);
    expect(needsMergeAck(m({}, [b({ selected: true, dstObjects: 4, status: "FAILED" })]))).toBe(false);
    expect(needsMergeAck(m({}, [b({ selected: false, dstObjects: 4 })]))).toBe(false);
  });
  it("parseExcludes splits, trims and drops empties", () => {
    expect(parseExcludes(" tmp/* , *.log,, ")).toEqual(["tmp/*", "*.log"]);
    expect(parseExcludes("")).toEqual([]);
  });
  it("warningText translates known codes with the bucket and never echoes an unknown server string", () => {
    const t = (k: string, v?: Record<string, string | number>) => `${k}|${v?.bucket ?? ""}`;
    expect(warningText(t, { code: "versions_not_carried", level: "warn", bucket: "bk1" })).toBe("objectMigration.warn.versions_not_carried|bk1");
    expect(warningText(t, { code: "src_unreachable", level: "blocker" })).toBe("objectMigration.preflight.srcUnreachable|");
    expect(warningText(t, { code: "<script>alert(1)</script>", level: "warn" })).toBe("<script>alert(1)</script>");
    expect(statusLabelKey("SEEDED")).toBe("objectMigration.status.SEEDED");
  });
});
