import { DATA_CODES, type DbStats, type FlipPlanLite, type RuntimeSnapshot } from "../data-contract";
import { PARITY_CODES } from "./db-stats";
import { buildVerifySuite, classifySuite, ponrBindingHash, reportHash, toGateCheck, type SuiteInputs } from "./verify-suite";
import { copied, database, inspected, makeSnap, measured, volume } from "../testing/fakes";

const FLIP: FlipPlanLite = { planHash: "a".repeat(32), hosts: ["a.example.com"], statefulHosts: ["a.example.com"], unavailable: null };
const RT: RuntimeSnapshot = {
  apps: [{ itemRef: "app:s:abc", name: "web", status: "RUNNING", envUnresolved: 0, envDropped: 0 }],
  databases: [{ itemRef: "database:s:pg", name: "pg", status: "RUNNING" }],
  hosts: [{ hostname: "a.example.com", state: "READY", stateful: true, blockReason: null }],
  incomplete: [],
};

function inputs(o: Partial<SuiteInputs> = {}): SuiteInputs {
  return {
    snap: makeSnap({ volumes: [copied("volume:s:abc:data")], databases: [database("database:s:pg", { task: "done" })] }),
    runtime: structuredClone(RT),
    objects: [],
    sourceStats: new Map<string, DbStats>([["database:s:pg", measured("database:s:pg", [["public.t", 5]])]]),
    targetStats: new Map<string, DbStats>([["database:s:pg", measured("database:s:pg", [["public.t", 5]])]]),
    drift: "same",
    flip: FLIP,
    ...o,
  };
}
const find = (checks: ReturnType<typeof buildVerifySuite>, checkId: string, subject?: string) => checks.filter((c) => c.checkId === checkId && (subject === undefined || c.subject === subject));

describe("buildVerifySuite: the all-green run", () => {
  it("passes everything with the right evidence kinds and no blockers", () => {
    const s = buildVerifySuite(inputs());
    expect(s.every((c) => c.status === "pass")).toBe(true);
    expect(find(s, "volume-parity")[0].evidence).toBe("migrator-reported"); // entries compared with the migrator's inspection
    expect(find(s, "db-logical-parity")[0]).toMatchObject({ evidence: "migrator-reported", code: PARITY_CODES.match, ackable: false });
    for (const id of ["app-running", "database-running", "host-ready", "coverage", "source-drift", "flip-plan"]) expect(find(s, id)[0].evidence).toBe("hub-verified");
    expect(classifySuite(s)).toEqual({ blocked: [], pending: [], acked: [] });
  });

  it("every check id is unique and fits the 80-char gate id limit", () => {
    const s = buildVerifySuite(inputs({ snap: makeSnap({ volumes: [copied(`volume:s:${"x".repeat(100)}:data`), copied("volume:s:b:data")], databases: [] }) }));
    const ids = s.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => i.length <= 80)).toBe(true);
  });
});

describe("volume checks", () => {
  it("a volume not DONE, or without the migrator's entry count, fails and is not ackable (data is missing)", () => {
    const s = buildVerifySuite(inputs({ snap: makeSnap({ volumes: [inspected("volume:s:a:data", 1, 1, { state: "COPYING" }), inspected("volume:s:b:data", 1, 1, { state: "DONE", entries: null })] }) }));
    const [a, b] = find(s, "volume-parity");
    expect(a.status).toBe("fail");
    expect(a.ackable).toBeUndefined();
    expect(b.status).toBe("fail");
    expect(classifySuite(s).blocked.map((c) => c.checkId)).toContain("volume-parity");
  });
  it("an inspected entry count that disagrees with the copy fails", () => {
    const s = buildVerifySuite(inputs({ snap: makeSnap({ volumes: [inspected("volume:s:a:data", 1, 100, { state: "DONE", entries: 99 })] }) }));
    expect(find(s, "volume-parity")[0]).toMatchObject({ status: "fail", params: { entries: 99, inspectedEntries: 100 } });
  });
  it("without an inspection the entry count is hub-verified only", () => {
    const s = buildVerifySuite(inputs({ snap: makeSnap({ volumes: [volume("volume:s:a:data", { state: "DONE", entries: 5 })] }) }));
    expect(find(s, "volume-parity")[0]).toMatchObject({ status: "pass", evidence: "hub-verified" });
  });
  it("an excluded volume is a warning, operator-attested", () => {
    const s = buildVerifySuite(inputs({ snap: makeSnap({ volumes: [volume("volume:s:a:data", { excluded: true, state: "EXCLUDED" })] }) }));
    expect(find(s, "volume-parity")[0]).toMatchObject({ status: "warn", evidence: "operator-attested", params: { outcome: "excluded" } });
  });
  it("a physical Postgres copy needs its version gate to have passed", () => {
    const v = (gates: Array<{ id: string; status: "pass" | "fail" | "unknown" }> | null) => buildVerifySuite(inputs({ snap: makeSnap({ volumes: [{ ...copied("volume:s:db:data"), destType: "db-data" as const, gates }] }) }));
    expect(find(v([{ id: "major", status: "pass" }]), "pg-physical")[0].status).toBe("pass");
    expect(find(v([{ id: "major", status: "fail" }]), "pg-physical")[0].status).toBe("fail");
    expect(find(v([]), "pg-physical")[0].status).toBe("unknown");
  });
});

describe("DB logical parity checks", () => {
  const withDb = (src: DbStats | undefined, tgt: DbStats | undefined, plane: "logical" | "volume" | "unsupported" = "logical") =>
    buildVerifySuite(
      inputs({
        snap: makeSnap({ volumes: [], databases: [database("database:s:pg", { task: "done", plane })] }),
        sourceStats: new Map(src ? [["database:s:pg", src]] : []),
        targetStats: new Map(tgt ? [["database:s:pg", tgt]] : []),
      }),
    );

  it("a lost row is a failure nobody can accept", () => {
    const s = withDb(measured("database:s:pg", [["t", 5]]), measured("database:s:pg", [["t", 4]]));
    const c = find(s, "db-logical-parity")[0];
    expect(c).toMatchObject({ status: "fail", code: PARITY_CODES.mismatch, ackable: false });
    expect(classifySuite(s).blocked).toHaveLength(1);
  });
  it("an unreported source, or a target that FAILED to measure, is `unknown` and may be accepted by a human who checked another way", () => {
    for (const [src, tgt] of [
      [undefined, measured("database:s:pg", [["t", 5]])],
      [measured("database:s:pg", [["t", 5]]), measured("database:s:pg", [], { state: "failed", reason: "verify-exec" })],
    ] as const) {
      const c = find(withDb(src, tgt), "db-logical-parity")[0];
      expect(c.status).toBe("unknown");
      expect(c.ackable).toBe(true);
    }
  });
  it("a target that has simply not been measured YET cannot be acknowledged away (it will be measured)", () => {
    const c = find(withDb(measured("database:s:pg", [["t", 5]]), undefined), "db-logical-parity")[0];
    expect(c).toMatchObject({ status: "unknown", code: PARITY_CODES.targetUnavailable, ackable: false });
  });
  it("target-extra rows are a warning, never blocking", () => {
    const s = withDb(measured("database:s:pg", [["t", 5]]), measured("database:s:pg", [["t", 6]]));
    expect(find(s, "db-logical-parity")[0].status).toBe("warn");
    expect(classifySuite(s).blocked).toHaveLength(0);
  });
  it("a physically copied database is compared only when the source reported a measurement (it is normally stopped)", () => {
    expect(find(withDb(undefined, undefined, "volume"), "db-logical-parity")).toHaveLength(0);
    expect(find(withDb(measured("database:s:pg", [], { state: "skipped", reason: "not-running" }), undefined, "volume"), "db-logical-parity")).toHaveLength(0);
    expect(find(withDb(measured("database:s:pg", [["t", 5]]), measured("database:s:pg", [["t", 5]]), "volume"), "db-logical-parity")).toHaveLength(1);
  });
  it("an engine the migrator cannot move is a coverage failure a human must acknowledge", () => {
    const s = buildVerifySuite(inputs({ snap: makeSnap({ volumes: [], databases: [database("database:s:m", { plane: "unsupported", engine: "MONGO", unsupportedReason: "no recipe" })] }) }));
    const c = find(s, "coverage-db")[0];
    expect(c).toMatchObject({ status: "fail", ackable: true, params: { outcome: "not-migrated", engine: "MONGO" } });
    expect(classifySuite(s).pending.map((x) => x.checkId)).toEqual(["coverage-db"]);
  });
});

describe("objects, runtime, coverage, drift and flip plan", () => {
  it("buckets must be VERIFIED", () => {
    const o = (status: string) => [{ id: "om1", status: "DONE", phase: null, cancelRequested: false, blockers: 0, buckets: [{ srcBucket: "media", selected: true, status, diffMissing: 1, diffDiffer: 0, diffExtra: 0 }, { srcBucket: "skip", selected: false, status: "PENDING", diffMissing: null, diffDiffer: null, diffExtra: null }] }];
    expect(find(buildVerifySuite(inputs({ objects: o("VERIFIED") })), "bucket").map((c) => c.status)).toEqual(["pass"]);
    const bad = find(buildVerifySuite(inputs({ objects: o("DIFFERS") })), "bucket");
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ status: "fail", params: { status: "DIFFERS", missing: 1 } });
  });

  it("an app that is not running is ackable; a database that is not running is not; hosts follow the cutover state machine", () => {
    const rt = structuredClone(RT);
    rt.apps[0].status = "STOPPED";
    rt.databases[0].status = "FAILED";
    rt.hosts = [
      { hostname: "ready.example.com", state: "READY", stateful: false, blockReason: null },
      { hostname: "ex.example.com", state: "EXCLUDED", stateful: false, blockReason: "generated-host" },
      { hostname: "bl.example.com", state: "BLOCKED", stateful: false, blockReason: "tunnel" },
      { hostname: "pending.example.com", state: "CERT_PENDING", stateful: false, blockReason: null },
    ];
    const s = buildVerifySuite(inputs({ runtime: rt }));
    expect(find(s, "app-running")[0]).toMatchObject({ status: "fail", ackable: true });
    expect(find(s, "database-running")[0].status).toBe("fail");
    expect(find(s, "database-running")[0].ackable).toBeUndefined();
    const hosts = Object.fromEntries(find(s, "host-ready").map((c) => [c.subject, [c.status, c.ackable ?? false]]));
    expect(hosts).toEqual({ "ready.example.com": ["pass", false], "ex.example.com": ["warn", false], "bl.example.com": ["fail", true], "pending.example.com": ["fail", false] });
  });

  it("carried-but-incomplete env is a (non-blocking) warning", () => {
    const rt = structuredClone(RT);
    rt.apps[0].envUnresolved = 2;
    const c = find(buildVerifySuite(inputs({ runtime: rt })), "env-carried")[0];
    expect(c).toMatchObject({ status: "warn", params: { unresolved: 2, dropped: 0 } });
  });

  it("every task that did not end DONE is a coverage failure to acknowledge; none gives one pass", () => {
    const rt = structuredClone(RT);
    rt.incomplete = [{ itemRef: "app:s:x", kind: "app", status: "FAILED" }, { itemRef: "service:s:y", kind: "service", status: "PENDING" }];
    const s = buildVerifySuite(inputs({ runtime: rt }));
    expect(find(s, "coverage").map((c) => [c.subject, c.status, c.ackable])).toEqual([["app:s:x", "fail", true], ["service:s:y", "fail", true]]);
    expect(find(buildVerifySuite(inputs()), "coverage")).toHaveLength(1);
  });

  it("drift: same passes, changed fails and unknown is unknown, both ackable", () => {
    const d = (drift: SuiteInputs["drift"]) => find(buildVerifySuite(inputs({ drift })), "source-drift")[0];
    expect(d("same")).toMatchObject({ status: "pass", ackable: false });
    expect(d("changed")).toMatchObject({ status: "fail", ackable: true });
    expect(d("unknown")).toMatchObject({ status: "unknown", ackable: true });
  });

  it("a missing flip plan fails and is not ackable: nothing can be approved without it", () => {
    const s = buildVerifySuite(inputs({ flip: { planHash: null, hosts: [], statefulHosts: [], unavailable: "flip-plan-error" } }));
    expect(find(s, "flip-plan")[0]).toMatchObject({ status: "fail", params: { reason: "flip-plan-error" } });
    expect(classifySuite(s).blocked.map((c) => c.checkId)).toContain("flip-plan");
  });
});

describe("classifySuite", () => {
  it("splits blocked / pending / acked and never counts a pass or a warning", () => {
    const rt = structuredClone(RT);
    rt.apps[0].status = "STOPPED";
    const s = buildVerifySuite(inputs({ runtime: rt, drift: "unknown" }));
    const c0 = classifySuite(s);
    expect(c0.pending.map((c) => c.checkId).sort()).toEqual(["app-running", "source-drift"]);
    const c1 = classifySuite(s, new Set([c0.pending[0].id]));
    expect(c1.acked).toHaveLength(1);
    expect(c1.pending).toHaveLength(1);
  });
});

describe("reportHash and ponrBindingHash", () => {
  it("depends on ids, statuses and codes, and ignores params and acks", () => {
    const a = buildVerifySuite(inputs());
    const b = buildVerifySuite(inputs());
    b.find((c) => c.checkId === "db-logical-parity")!.params = { sourceRows: 999 };
    expect(reportHash(a)).toBe(reportHash(b));
    const c = buildVerifySuite(inputs({ drift: "changed" }));
    expect(reportHash(c)).not.toBe(reportHash(a));
    const d = buildVerifySuite(inputs());
    d[0].status = "fail";
    expect(reportHash(d)).not.toBe(reportHash(a));
  });
  it("binds the review to the plan and the stateful hosts", () => {
    const r = reportHash(buildVerifySuite(inputs()));
    const h = ponrBindingHash(r, FLIP);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(ponrBindingHash(r, { ...FLIP, planHash: "b".repeat(32) })).not.toBe(h);
    expect(ponrBindingHash(r, { ...FLIP, statefulHosts: [] })).not.toBe(h);
    expect(ponrBindingHash(r, { ...FLIP, statefulHosts: ["z.example.com", "a.example.com"] })).toBe(ponrBindingHash(r, { ...FLIP, statefulHosts: ["a.example.com", "z.example.com"] }));
    expect(ponrBindingHash("0".repeat(64), FLIP)).not.toBe(h);
  });
  it("toGateCheck strips helper fields and sets `acked`", () => {
    const c = buildVerifySuite(inputs({ drift: "changed" })).find((x) => x.checkId === "source-drift")!;
    const g = toGateCheck(c, true);
    expect(g).not.toHaveProperty("checkId");
    expect(g).not.toHaveProperty("subject");
    expect(g.acked).toBe(true);
    expect(toGateCheck(buildVerifySuite(inputs({ snap: makeSnap({ volumes: [copied("volume:s:a:data")], databases: [] }) }))[0]).subject).toBe("volume:s:a:data");
    void DATA_CODES;
  });
});

describe("service volume coverage (R53)", () => {
  const sv = (key: string, policy: string, streamed: boolean, serviceName: string | null = "search-a") => ({ serviceItemRef: "service:s:svc1", serviceName, key, policy, streamed });
  const rows = (items: ReturnType<typeof sv>[], extra: Partial<SuiteInputs> = {}) => find(buildVerifySuite(inputs({ snap: makeSnap({ volumes: [copied("volume:s:abc:data")], databases: [], serviceVolumes: items }), ...extra })), "coverage-service-volume");

  it("a volume the stream moved has no coverage row of its own (its volume-parity row judges it)", () => {
    expect(rows([sv("index", "copy", true)])).toEqual([]);
  });
  it("a copy volume the stream cannot move is a not-migrated row that fails and needs an acknowledgement", () => {
    const [r] = rows([sv("index", "copy", false)]);
    expect(r).toMatchObject({ subject: "service:s:svc1/index", status: "fail", code: DATA_CODES.verifyServiceVolume, ackable: true, evidence: "hub-verified", params: { service: "search-a", key: "index", outcome: "not-migrated", reason: "not-streamable" } });
  });
  it("a skipped volume is listed as not migrated and held for an acknowledgement; an empty one is a visible warning only", () => {
    const [skipped, empty] = rows([sv("analytics", "skip", false), sv("cache", "empty", false)]);
    expect(skipped).toMatchObject({ code: DATA_CODES.verifyServiceVolumeSkipped, status: "fail", ackable: true, params: { outcome: "not-migrated", reason: "policy-skip" } });
    expect(empty).toMatchObject({ code: DATA_CODES.verifyServiceVolumeEmpty, status: "warn", ackable: false, params: { outcome: "starts-empty", reason: "starts-empty" } });
  });
  it("never reads as clean: the suite is not all-pass, the row is pending until acknowledged and an ack clears it", () => {
    const s = buildVerifySuite(inputs({ snap: makeSnap({ volumes: [copied("volume:s:abc:data")], databases: [database("database:s:pg", { task: "done" })], serviceVolumes: [sv("analytics", "skip", false)] }) }));
    const c = find(s, "coverage-service-volume")[0];
    expect(classifySuite(s).pending.map((x) => x.id)).toContain(c.id);
    expect(classifySuite(s, new Set([c.id])).pending).toEqual([]);
    expect(classifySuite(s).blocked).toEqual([]);
  });
  it("a service volume is named by its service ref when the name is unknown, and ids stay unique and short", () => {
    const [r] = rows([sv("k".repeat(60), "copy", false, null)]);
    expect(r.params).toMatchObject({ service: "service:s:svc1" });
    expect(r.id.length).toBeLessThanOrEqual(80);
  });
  it("a snapshot from a port that cannot say adds nothing", () => {
    expect(find(buildVerifySuite(inputs()), "coverage-service-volume")).toEqual([]);
  });
});
