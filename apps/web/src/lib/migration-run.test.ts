import { formatBytes } from "./import";
import { describe, it, expect } from "vitest";
import {
  MIGRATION_RUN_STEP_KEYS,
  MIGRATION_RUN_STATUSES,
  approvalExpired,
  attestationVoid,
  approvalIssues,
  approvalPayload,
  ackRows,
  blockingChecks,
  buildLaunchInput,
  checksNeedingInput,
  codeKey,
  codeText,
  confirmNames,
  dryRunItemsSorted,
  dryRunVerdict,
  errorText,
  evidenceCounts,
  humanizeCode,
  humanizeKey,
  campaignRollup,
  buildCampaignReport,
  campaignReportHref,
  heldWorkersOf,
  sourceHostLabel,
  sourceHostNames,
  defaultPlacement,
  evidenceTone,
  hintsClosed,
  placementTargetCount,
  policyInputs,
  runTitleParts,
  sourceServersOf,
  targetServerNames,
  validAppItemRef,
  validCampaign,
  validDigest,
  validImageRef,
  validKeyDir,
  EMPTY_POLICIES,
  HOST_LOOP_FORM_DEFAULTS,
  isPastPonr,
  isTerminalRun,
  joinConfirmNames,
  launchIssues,
  looksLikeEmail,
  mergeEvents,
  paramText,
  paramVars,
  progressPct,
  progressText,
  REVIEW_LABEL_KEY,
  reviewLabel,
  reviewValue,
  runListRefetchInterval,
  runRefetchInterval,
  runStatusColor,
  secondsUntil,
  stepStatusColor,
  stepsSummary,
  visibleSteps,
} from "./migration-run";
import { translate } from "../i18n/translate";
import en from "../i18n/locales/en";
import type { MigrationRunApprovalBinding, MigrationRunEvent, MigrationRunGate, MigrationRunStepView, MigrationRunView } from "./types";

const t = (key: string, vars?: Record<string, string | number>) => translate(en as Record<string, unknown>, key, vars);

const HASH = "a".repeat(64);
const binding = (over: Partial<MigrationRunApprovalBinding> = {}): MigrationRunApprovalBinding => ({
  inputHash: HASH,
  ponr: false,
  confirm: "none",
  ttlSec: null,
  requiresDataRisk: false,
  ackable: [],
  requiredAcks: [],
  review: {},
  ...over,
});
const draft = (over: Partial<Parameters<typeof approvalIssues>[1]> = {}) => ({ reviewedHash: HASH, acks: new Set<string>(), typed: [] as string[], dataRisk: false, ...over });
const run = { id: "run1", targetServerName: "tugra-1", sourceHost: "coolify.example.org" };

const step = (key: MigrationRunStepView["key"], status: MigrationRunStepView["status"], over: Partial<MigrationRunStepView> = {}): MigrationRunStepView => ({
  key, idx: MIGRATION_RUN_STEP_KEYS.indexOf(key), kind: "auto", status, rollbackClass: "FREE", attempt: 0, skippedCode: null, gate: null, approval: null, wait: null, progress: null,
  evidence: { attestations: [], attachments: [] }, notBefore: null, startedAt: null, finishedAt: null, lastError: null,
  allowed: { approve: false, retry: false, skip: false, evidence: false, attach: false, command: false }, ...over,
});

describe("vocabulary", () => {
  it("lists the 14 steps in order and the 13 run statuses", () => {
    expect(MIGRATION_RUN_STEP_KEYS).toHaveLength(14);
    expect(MIGRATION_RUN_STEP_KEYS[0]).toBe("PREFLIGHT");
    expect(MIGRATION_RUN_STEP_KEYS[10]).toBe("CUTOVER");
    expect(MIGRATION_RUN_STATUSES).toHaveLength(13);
  });
  it("knows which statuses are settled", () => {
    for (const s of ["ABORTED", "ROLLED_BACK", "REVERSED", "COMPLETED", "DRY_RUN_DONE"] as const) expect(isTerminalRun(s)).toBe(true);
    for (const s of ["QUEUED", "RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING", "FAILED"] as const) expect(isTerminalRun(s)).toBe(false);
  });
  it("gives every status a colour", () => {
    for (const s of MIGRATION_RUN_STATUSES) expect(runStatusColor(s)).toMatch(/^var\(--c-/);
    expect(stepStatusColor("PASSED")).toBe("var(--c-g)");
    expect(stepStatusColor("FAILED")).toBe("var(--c-r)");
  });
});

describe("polling", () => {
  it("polls fast while busy, slowly while waiting, never when settled", () => {
    expect(runRefetchInterval(undefined)).toBe(3000);
    expect(runRefetchInterval({ status: "RUNNING" })).toBe(2000);
    expect(runRefetchInterval({ status: "ROLLING_BACK" })).toBe(2000);
    expect(runRefetchInterval({ status: "WAITING" })).toBe(5000);
    expect(runRefetchInterval({ status: "FAILED" })).toBe(5000);
    expect(runRefetchInterval({ status: "COMPLETED" })).toBe(false);
    expect(runRefetchInterval({ status: "DRY_RUN_DONE" })).toBe(false);
    // a settled run whose async step (decommission) is still moving keeps polling
    expect(runRefetchInterval({ status: "COMPLETED", steps: [{ status: "PASSED" }, { status: "RUNNING" }] })).toBe(2000);
    expect(runRefetchInterval({ status: "COMPLETED", steps: [{ status: "WAITING_TIMER" }] })).toBe(5000);
    expect(runRefetchInterval({ status: "COMPLETED", steps: [{ status: "PASSED" }, { status: "WAITING_APPROVAL" }] })).toBe(false);
  });
  it("polls the list fast only while a run is live", () => {
    expect(runListRefetchInterval([{ status: "RUNNING" }])).toBe(4000);
    expect(runListRefetchInterval([{ status: "COMPLETED" }])).toBe(20000);
    expect(runListRefetchInterval(undefined)).toBe(20000);
  });
});

describe("codes and params", () => {
  it("flattens a dotted code into one locale key", () => {
    expect(codeKey("run.ponr.reached")).toBe("migrationRun.codes.run_ponr_reached");
    expect(codeKey("preflight.agent-offline")).toBe("migrationRun.codes.preflight_agent-offline");
  });
  it("localizes a known code", () => {
    expect(codeText(t, "run.ponr.reached")).toBe("Point of no return reached.");
    expect(codeText(t, "step.failed")).toBe("Step failed.");
  });
  it("shows an unknown code humanized with its params instead of hiding it", () => {
    expect(codeText(t, "data-final.transfer-diverged", { volume: "db-data", n: 2 })).toBe("data final: transfer diverged (volume=db-data, n=2)");
    expect(codeText(t, "oddity")).toBe("oddity");
  });
  it("humanizes codes and camelCase keys", () => {
    expect(humanizeCode("cutover.host-not-verified")).toBe("cutover: host not verified");
    expect(humanizeKey("windowEstimateSec")).toBe("window estimate sec");
  });
  it("renders every param shape as text and cuts long lists", () => {
    expect(paramText(null)).toBe("-");
    expect(paramText(undefined)).toBe("-");
    expect(paramText(["a", "b", null])).toBe("a, b, -");
    expect(paramText(true)).toBe("true");
    const vars = paramVars({ hosts: ["1", "2", "3", "4", "5", "6", "7"], n: 3, ok: false });
    expect(vars.hosts).toBe("1, 2, 3, 4, 5 +2");
    expect(vars.n).toBe(3);
    expect(vars.ok).toBe("false");
    expect(paramVars(null)).toEqual({});
  });
  it("shows a number under a key ending in Bytes as a size", () => {
    const vars = paramVars({ dumpBytes: 3 * 1024 ** 3, capBytes: 256 * 1024 ** 2, bytes: 5, n: 4 });
    expect(vars.dumpBytes).toBe(formatBytes(3 * 1024 ** 3));
    expect(vars.capBytes).toBe(formatBytes(256 * 1024 ** 2));
    expect(vars.bytes).toBe(5); // only the `...Bytes` convention is a size
    expect(vars.n).toBe(4);
    expect(paramVars({ dumpBytes: null }).dumpBytes).toBe("-");
  });
  it("describes the route of a database in plain words, with its size", () => {
    expect(codeText(t, "data-seed.db-lane-stream", { engine: "POSTGRES", dumpBytes: 3 * 1024 ** 3 })).toBe(`This POSTGRES database (${formatBytes(3 * 1024 ** 3)}) moves as a checked stream. Any size works.`);
    expect(codeText(t, "data-seed.disk-insufficient", { needBytes: 10 * 1024 ** 3, freeBytes: 2 * 1024 ** 3 })).toContain(`${formatBytes(2 * 1024 ** 3)} free`);
  });
  it("shows the lane of a database in words", () => {
    expect(codeText(t, "data-seed.dry.db-lane", { lane: "stream", dumpBytes: 2 * 1024 ** 3 })).toBe(`This database (${formatBytes(2 * 1024 ** 3)}): checked stream, any size.`);
    expect(codeText(t, "data-seed.dry.db-lane", { lane: "logical", dumpBytes: 1024 ** 2 })).toContain("one dump");
    expect(codeText(t, "data-seed.dry.db-lane", { lane: "pending", dumpBytes: null })).toBe("This database (-): waiting for its size.");
  });
  it("interpolates params into a known code", () => {
    expect(t("migrationRun.progressOf", { done: 3, total: 9, unit: "volumes" })).toBe("3 / 9 volumes");
  });
});

describe("progress", () => {
  it("never invents a percentage without a total", () => {
    expect(progressPct(null)).toBeNull();
    expect(progressPct({ done: 3, total: 0, unit: "item" })).toBeNull();
    expect(progressPct({ done: 1, total: 4, unit: "item" })).toBe(25);
    expect(progressPct({ done: 9, total: 4, unit: "item" })).toBe(100);
  });
  it("formats bytes, seconds and counts", () => {
    expect(progressText(t, { done: 1024 * 1024, total: 2 * 1024 * 1024, unit: "byte" })).toBe("1.0 MiB / 2.0 MiB");
    expect(progressText(t, { done: 3, total: 9, unit: "volume" })).toBe("3 / 9 volumes");
    expect(progressText(t, { done: 30, total: 120, unit: "second" })).toBe("30 s / 2 min");
  });
  it("counts the seconds until an instant, never negative", () => {
    const now = Date.parse("2026-11-16T10:00:00Z");
    expect(secondsUntil("2026-11-16T10:00:30Z", now)).toBe(30);
    expect(secondsUntil("2026-11-16T09:00:00Z", now)).toBe(0);
    expect(secondsUntil(null, now)).toBeNull();
    expect(secondsUntil("nope", now)).toBeNull();
  });
});

describe("steps", () => {
  const view = (steps: MigrationRunStepView[]) => ({ steps } as Pick<MigrationRunView, "steps">);
  it("orders steps and summarizes passed over applicable", () => {
    const v = view([step("IMPORT", "RUNNING"), step("PREFLIGHT", "PASSED"), step("DNS_PREPARE", "SKIPPED")]);
    expect(visibleSteps(v).map((s) => s.key)).toEqual(["PREFLIGHT", "IMPORT", "DNS_PREPARE"]);
    expect(stepsSummary(v)).toEqual({ passed: 1, total: 2 });
  });
  it("detects the point of no return", () => {
    expect(isPastPonr({ ponrAt: null })).toBe(false);
    expect(isPastPonr({ ponrAt: "2026-11-16T10:00:00Z" })).toBe(true);
  });
});

describe("gates", () => {
  const gate: MigrationRunGate = {
    passed: false,
    checks: [
      { id: "a", status: "pass", code: "x", evidence: "hub-verified" },
      { id: "b", status: "pass", code: "x", evidence: "migrator-reported" },
      { id: "c", status: "fail", code: "y", ownerInput: "acmeEmail" },
      { id: "d", status: "unknown", code: "z" },
      { id: "e", status: "fail", code: "w", acked: true },
      { id: "f", status: "warn", code: "v" },
    ],
  };
  it("treats unknown as blocking and skips acked failures and warnings", () => {
    expect(blockingChecks(gate).map((c) => c.id)).toEqual(["c", "d"]);
    expect(blockingChecks(null)).toEqual([]);
  });
  it("finds the checks an owner input would resolve", () => {
    expect(checksNeedingInput(gate).map((c) => c.id)).toEqual(["c"]);
  });
  it("counts passes by evidence kind, so a weaker kind is never merged into a stronger one", () => {
    expect(evidenceCounts(gate)).toEqual({ "hub-verified": 1, "migrator-reported": 1, "operator-attested": 0, "source-api-reported": 0, "host-loop-reported": 0 });
  });
  it("lists dry-run blocks first and totals the verdict", () => {
    const progress = { done: 0, total: 0, unit: "item" as const, dryRun: [
      { code: "i", level: "info" as const }, { code: "b", level: "block" as const }, { code: "u", level: "unknown" as const }, { code: "w", level: "warn" as const },
    ] };
    expect(dryRunItemsSorted(progress).map((d) => d.level)).toEqual(["block", "unknown", "warn", "info"]);
    expect(dryRunVerdict({ steps: [step("PREFLIGHT", "PASSED", { progress })] })).toEqual({ blocks: 1, unknown: 1, warns: 1 });
  });
});

describe("events", () => {
  const ev = (seq: number): MigrationRunEvent => ({ seq, at: "2026-11-16T10:00:00Z", stepKey: null, level: "info", code: "step.entered", params: null, actorId: null });
  it("merges by seq, ascending, without duplicates", () => {
    const merged = mergeEvents([ev(1), ev(2)], [ev(2), ev(3)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(mergeEvents([ev(2)], [ev(1)]).map((e) => e.seq)).toEqual([1, 2]);
  });
  it("returns the same array for an empty page and caps the log to the newest events", () => {
    const base = [ev(1)];
    expect(mergeEvents(base, [])).toBe(base);
    const many = Array.from({ length: 1100 }, (_, i) => ev(i + 1));
    const merged = mergeEvents([], many);
    expect(merged).toHaveLength(1000);
    expect(merged[0].seq).toBe(101);
  });
});

describe("typed confirmation", () => {
  it("names what to type for each confirmation kind", () => {
    expect(confirmNames("none", run)).toEqual([]);
    expect(confirmNames("run-id", run)).toEqual(["run1"]);
    expect(confirmNames("target-server", run)).toEqual(["tugra-1"]);
    expect(confirmNames("source-host", run)).toEqual(["coolify.example.org"]);
    expect(confirmNames("target-server+source-host", run)).toEqual(["tugra-1", "coolify.example.org"]);
  });
  it("blocks (null) when a needed name is unknown instead of accepting an empty match", () => {
    expect(confirmNames("target-server", { ...run, targetServerName: null })).toBeNull();
    expect(confirmNames("source-host", { ...run, sourceHost: "  " })).toBeNull();
    expect(confirmNames("target-server+source-host", { ...run, sourceHost: null })).toBeNull();
  });
  it("joins typed names with one space", () => {
    expect(joinConfirmNames([" tugra-1 ", "coolify.example.org"])).toBe("tugra-1 coolify.example.org");
  });
});

describe("approval bound to the reviewed hash", () => {
  it("is ready when nothing is required", () => {
    expect(approvalIssues(binding(), draft(), [])).toEqual([]);
  });
  it("is stale when the live hash moved after the operator started", () => {
    expect(approvalIssues(binding({ inputHash: "b".repeat(64) }), draft(), [])).toContain("stale");
  });
  it("needs every required acknowledgement", () => {
    const b = binding({ ackable: ["x", "y"], requiredAcks: ["x"] });
    expect(approvalIssues(b, draft(), [])).toContain("ack-missing");
    expect(approvalIssues(b, draft({ acks: new Set(["x"]) }), [])).toEqual([]);
  });
  it("needs the exact typed name(s), case-sensitive", () => {
    const b = binding({ confirm: "target-server" });
    expect(approvalIssues(b, draft({ typed: [] }), ["tugra-1"])).toContain("name-mismatch");
    expect(approvalIssues(b, draft({ typed: ["Tugra-1"] }), ["tugra-1"])).toContain("name-mismatch");
    expect(approvalIssues(b, draft({ typed: [" tugra-1 "] }), ["tugra-1"])).toEqual([]);
    const both = binding({ confirm: "target-server+source-host" });
    expect(approvalIssues(both, draft({ typed: ["tugra-1"] }), ["tugra-1", "h"])).toContain("name-mismatch");
    expect(approvalIssues(both, draft({ typed: ["tugra-1", "h"] }), ["tugra-1", "h"])).toEqual([]);
  });
  it("cannot be confirmed when a name is unknown", () => {
    expect(approvalIssues(binding({ confirm: "source-host" }), draft(), null)).toContain("name-unavailable");
  });
  it("needs the data-risk acknowledgement on a point-of-no-return approval", () => {
    const b = binding({ ponr: true, requiresDataRisk: true });
    expect(approvalIssues(b, draft(), [])).toEqual(["data-risk"]);
    expect(approvalIssues(b, draft({ dataRisk: true }), [])).toEqual([]);
  });
  it("sends the reviewed hash, only allowed acks and the joined names", () => {
    const b = binding({ confirm: "target-server+source-host", requiresDataRisk: true, ackable: ["x"], requiredAcks: ["r"] });
    const p = approvalPayload(b, draft({ reviewedHash: HASH, acks: new Set(["x", "r", "rogue"]), typed: ["tugra-1", "h"], dataRisk: true }));
    expect(p).toEqual({ boundHash: HASH, acks: ["x", "r"], confirmName: "tugra-1 h", acceptDataRisk: true });
    expect(approvalPayload(binding(), draft())).toEqual({ boundHash: HASH, acks: [] });
  });
  it("lists acknowledgements required-first, one row per check id", () => {
    const gate: MigrationRunGate = { passed: false, checks: [{ id: "x", status: "warn", code: "c1", subject: "a" }, { id: "x", status: "warn", code: "c1", subject: "b" }, { id: "r", status: "fail", code: "c2" }] };
    const rows = ackRows(binding({ ackable: ["x"], requiredAcks: ["r"] }), gate);
    expect(rows.map((r) => [r.id, r.required, r.checks.length])).toEqual([["r", true, 1], ["x", false, 2]]);
  });
  it("knows when a stored approval expired", () => {
    const now = Date.parse("2026-11-16T10:00:00Z");
    expect(approvalExpired(null, now)).toBe(false);
    expect(approvalExpired("2026-11-16T09:59:00Z", now)).toBe(true);
    expect(approvalExpired("2026-11-16T10:30:00Z", now)).toBe(false);
  });
  it("a write-gap attestation is void once the gate shows a longer gap, so the row offers it again", () => {
    const gate = (gapMinutes: number | null) => ({ id: "freeze.tick-gap", status: "fail" as const, code: "freeze.tick-gap-exceeded", params: { gapMinutes }, attestable: ["tick-gap-accepted"] });
    const att = (note?: string) => [{ checkId: "tick-gap-accepted", ...(note ? { note } : {}) }];
    expect(attestationVoid("tick-gap-accepted", att("gapMinutes=20"), gate(45))).toBe(true);
    expect(attestationVoid("tick-gap-accepted", att("gapMinutes=45"), gate(45))).toBe(false);
    expect(attestationVoid("tick-gap-accepted", att("gapMinutes=45 ok"), gate(30))).toBe(false);
    expect(attestationVoid("tick-gap-accepted", att("gapMinutes=45"), gate(null))).toBe(true);
    expect(attestationVoid("tick-gap-accepted", att("gapMinutes=unknown"), gate(null))).toBe(false);
    expect(attestationVoid("tick-gap-accepted", att(), gate(45))).toBe(true); // records no gap
    // no failing gap check, or another attestation: nothing is void
    expect(attestationVoid("tick-gap-accepted", att("gapMinutes=20"), undefined)).toBe(false);
    expect(attestationVoid("tick-gap-accepted", att("gapMinutes=20"), { ...gate(45), status: "warn" })).toBe(false);
    expect(attestationVoid("source-quiesced", att("x"), gate(45))).toBe(false);
  });
  it("labels every key the FREEZE approval review lists, so none shows as a machine-derived label", () => {
    const keys = "controller apps services stopList estimateSec estimateDataSec estimateBuildSec estimateStartSec estimateHealthSec estimateAcmeSec estimateBytes estimateHubBytes writeGapSec tickGapAcceptedSec tickGapNeedsAttestation keepsStopped scheduledFor".split(" ");
    for (const k of keys) {
      expect(REVIEW_LABEL_KEY[k], k).toBeTruthy();
      expect(reviewLabel(t, k), k).not.toBe(humanizeKey(k));
    }
    expect(reviewLabel(t, "estimateSec")).toBe("Estimated downtime");
  });
  it("labels review rows and humanizes sizes, durations and booleans", () => {
    expect(reviewLabel(t, "statefulHosts")).toBe("Stateful hosts");
    expect(reviewLabel(t, "someNewKey")).toBe("some new key");
    expect(reviewValue(t, "windowEstimateSec", 600).text).toBe("10 min");
    expect(reviewValue(t, "dataBytes", 2 * 1024 * 1024).text).toBe("2.0 MiB");
    expect(reviewValue(t, "x", true).text).toBe("Yes");
    expect(reviewValue(t, "hosts", ["a", "b"]).text).toBe("a, b");
  });
});

describe("launch form", () => {
  const base = { sessionId: "s1", sourceKind: "coolify" as const, targetServerId: "srv1", planHash: "a".repeat(32), mode: "copy" as const, topology: "two-box" as const, dryRun: true, acmeEmail: "", allowBind: false, allowLiveShapeProbe: false, sourceController: "manual" as const, observeMinutes: "30" };
  it("validates the email shape and the observe window", () => {
    expect(looksLikeEmail("ops@example.org")).toBe(true);
    expect(looksLikeEmail("nope")).toBe(false);
    expect(launchIssues(base)).toEqual([]);
    expect(launchIssues({ ...base, targetServerId: "" })).toEqual(["target"]);
    expect(launchIssues({ ...base, acmeEmail: "bad" })).toEqual(["email"]);
    expect(launchIssues({ ...base, observeMinutes: "5000" })).toEqual(["observe"]);
    expect(launchIssues({ ...base, observeMinutes: "1.5" })).toEqual(["observe"]);
    expect(launchIssues({ ...base, observeMinutes: "" })).toEqual(["observe"]);
  });
  it("builds a secret-free create body that carries the reviewed plan's choices", () => {
    const body = buildLaunchInput({ ...base, extras: { acks: [{ code: "app.env.unresolved", itemRef: "app:s:web" }], dbDataModes: { "database:s:db": "volume" } } });
    expect(body).toMatchObject({
      sessionId: "s1", sourceKind: "coolify", targetServerId: "srv1", planHash: "a".repeat(32), mode: "copy", topology: "two-box", dryRun: true,
      acks: [{ code: "app.env.unresolved", itemRef: "app:s:web" }], dbDataModes: { "database:s:db": "volume" },
      options: { observeMinutes: 30 }, inputs: { acmeEmail: "unknown", allowBind: false, allowLiveShapeProbe: false, sourceController: "manual" },
    });
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });
  it("sends a given ACME email and omits empty extras", () => {
    const body = buildLaunchInput({ ...base, acmeEmail: " ops@example.org " });
    expect(body.inputs?.acmeEmail).toBe("ops@example.org");
    expect(body).not.toHaveProperty("acks");
    expect(body).not.toHaveProperty("dbDataModes");
  });
});

describe("errors", () => {
  it("localizes the contract's machine codes and passes other messages through", () => {
    expect(errorText(t, new Error("409 approval-stale"))).toBe("What you approved no longer matches the current state. Review it again.");
    expect(errorText(t, new Error("run-past-ponr"))).toContain("point of no return");
    expect(errorText(t, new Error("human-confirmation-required"))).toContain("person");
    expect(errorText(t, new Error("Something specific"))).toBe("Something specific");
    expect(errorText(t, null)).toBe("Something went wrong. Try again.");
  });
});

describe("multi-host typed confirmation", () => {
  const multi = {
    ...run,
    targetServers: [
      { serverId: "s2", serverName: "tugra-b", primary: false },
      { serverId: "s1", serverName: "tugra-1", primary: true },
      { serverId: "s3", serverName: "tugra-1", primary: false },
    ],
  };
  it("names every distinct target server, sorted by code point", () => {
    expect(targetServerNames(multi)).toEqual(["tugra-1", "tugra-b"]);
    expect(confirmNames("target-servers", multi)).toEqual(["tugra-1", "tugra-b"]);
    expect(confirmNames("target-servers+source-host", multi)).toEqual(["tugra-1", "tugra-b", "coolify.example.org"]);
  });
  it("blocks when ANY target server has no known name, so no host can be skipped", () => {
    const hole = { ...multi, targetServers: [...multi.targetServers, { serverId: "s4", serverName: null, primary: false }] };
    expect(confirmNames("target-servers", hole)).toBeNull();
    expect(confirmNames("target-servers+source-host", { ...multi, sourceHost: null })).toBeNull();
  });
  it("falls back to the default server for a run view without the list", () => {
    expect(targetServerNames(run)).toEqual(["tugra-1"]);
  });
  it("joins the server names with a comma and a space, then the source host after one space (what the hub compares)", () => {
    expect(joinConfirmNames(["tugra-1", "tugra-b"], "target-servers")).toBe("tugra-1, tugra-b");
    expect(joinConfirmNames(["tugra-1", "tugra-b", "h"], "target-servers+source-host")).toBe("tugra-1, tugra-b h");
    expect(joinConfirmNames(["tugra-1", "h"], "target-server+source-host")).toBe("tugra-1 h");
  });
  it("an approval payload for a multi-host binding carries the joined text", () => {
    const b = binding({ confirm: "target-servers+source-host" });
    const p = approvalPayload(b, draft({ typed: ["tugra-1", "tugra-b", "h"] }));
    expect(p.confirmName).toBe("tugra-1, tugra-b h");
  });
});

describe("source hosts and placement", () => {
  const items = [
    { itemRef: "app:host-a:web", kind: "app" as const },
    { itemRef: "database:host-a:db1", kind: "database" as const },
    { itemRef: "volume:host-b:v1:data", kind: "volume" as const },
    { itemRef: "service:host-b:svc", kind: "service" as const },
    { itemRef: "app:_:orphan", kind: "app" as const },
  ];
  it("reads the source hosts from the item refs, with counts, the unknown host last", () => {
    expect(sourceServersOf(items)).toEqual([
      { ref: "host-a", apps: 1, databases: 1, services: 0, volumes: 0 },
      { ref: "host-b", apps: 0, databases: 0, services: 1, volumes: 1 },
      { ref: "_", apps: 1, databases: 0, services: 0, volumes: 0 },
    ]);
    expect(sourceServersOf([])).toEqual([]);
  });
  it("places every host on the default server first, and counts the distinct targets", () => {
    const rows = sourceServersOf(items);
    const map = defaultPlacement(rows, "srv1");
    expect(map).toEqual({ "host-a": "srv1", "host-b": "srv1", _: "srv1" });
    expect(placementTargetCount("srv1", map)).toBe(1);
    expect(placementTargetCount("srv1", { ...map, "host-b": "srv2" })).toBe(2);
    expect(placementTargetCount("srv1", null)).toBe(1);
  });
});

describe("launch form: placement, runner, policies", () => {
  const base = { sessionId: "s1", sourceKind: "coolify" as const, targetServerId: "srv1", planHash: "a".repeat(32), mode: "copy" as const, topology: "two-box" as const, dryRun: true, acmeEmail: "", allowBind: false, allowLiveShapeProbe: false, sourceController: "manual" as const, observeMinutes: "30" };
  it("sends nothing new for a plain single-target form (a stored form keeps working)", () => {
    const body = buildLaunchInput(base);
    expect(body).not.toHaveProperty("serverMap");
    expect(body).not.toHaveProperty("campaign");
    expect(body.options).toEqual({ observeMinutes: 30 });
    expect(body.inputs).toEqual({ acmeEmail: "unknown", allowBind: false, allowLiveShapeProbe: false, sourceController: "manual" });
  });
  it("sends the placement as the run-level serverMap and keeps the form's target as the default", () => {
    const body = buildLaunchInput({ ...base, placement: { "host-a": "srv1", "host-b": "srv2" }, campaign: "  wave-1 " });
    expect(body.serverMap).toEqual({ "host-a": "srv1", "host-b": "srv2" });
    expect(body.targetServerId).toBe("srv1");
    expect(body.campaign).toBe("wave-1");
  });
  it("sends the host-loop runner with its tuning, and only that runner's tuning", () => {
    const hostLoop = { ...HOST_LOOP_FORM_DEFAULTS, parallel: "2", retries: "0" };
    expect(buildLaunchInput({ ...base, sourceRunner: "coolify-host-loop", hostLoop }).options).toEqual({
      observeMinutes: 30,
      sourceRunner: "coolify-host-loop",
      hostLoop: { keyDir: "/data/coolify/ssh/keys", parallel: 2, connectTimeoutSec: 15, retries: 0 },
    });
    expect(buildLaunchInput({ ...base, sourceRunner: "operator", hostLoop }).options).toEqual({ observeMinutes: 30 });
  });
  it("sends the build, large-db and stop-source options only when they differ from the defaults", () => {
    expect(buildLaunchInput({ ...base, deployWaves: "earlyBuild", deployConcurrency: "2", largeDbMode: "refuse", stopSource: true }).options).toEqual({
      observeMinutes: 30, deployWaves: "earlyBuild", deployConcurrency: 2, largeDbMode: "refuse", stopSource: true,
    });
    expect(buildLaunchInput({ ...base, deployWaves: "single", deployConcurrency: " ", largeDbMode: "stream-logical", stopSource: false }).options).toEqual({ observeMinutes: 30 });
  });
  it("sends the service start choice only when it is not the default", () => {
    expect(buildLaunchInput({ ...base, serviceStart: "none" }).options).toEqual({ observeMinutes: 30, serviceStart: "none" });
    expect(buildLaunchInput({ ...base, serviceStart: "all" }).options).toEqual({ observeMinutes: 30, serviceStart: "all" });
    expect(buildLaunchInput({ ...base, serviceStart: "dependencies" }).options).toEqual({ observeMinutes: 30 });
  });
  it("sends only the policy answers that were given; an unanswered one keeps the hub's safe default", () => {
    expect(policyInputs(undefined)).toEqual({});
    expect(policyInputs(EMPTY_POLICIES)).toEqual({});
    expect(policyInputs({ ...EMPTY_POLICIES, minioPolicy: "mirror", workerPolicy: "exclude" })).toEqual({ minioPolicy: "mirror", workerPolicy: "exclude" });
    expect(buildLaunchInput({ ...base, policies: { ...EMPTY_POLICIES, orphanVolumePolicy: "skip" } }).inputs).toMatchObject({ orphanVolumePolicy: "skip" });
  });
  it("refuses what the hub would refuse", () => {
    expect(launchIssues({ ...base, placement: {} })).toEqual(["placement"]);
    expect(launchIssues({ ...base, placement: { a: "" } })).toEqual(["placement"]);
    expect(launchIssues({ ...base, placement: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`h${i}`, "srv1"])) })).toEqual(["placement"]);
    expect(launchIssues({ ...base, placement: { a: "srv1" } })).toEqual([]);
    expect(launchIssues({ ...base, campaign: "x".repeat(81) })).toEqual(["campaign"]);
    expect(launchIssues({ ...base, campaign: "   " })).toEqual([]);
    expect(launchIssues({ ...base, sourceRunner: "coolify-host-loop", hostLoop: { ...HOST_LOOP_FORM_DEFAULTS, keyDir: "keys" } })).toEqual(["hostLoop"]);
    expect(launchIssues({ ...base, sourceRunner: "coolify-host-loop", hostLoop: { ...HOST_LOOP_FORM_DEFAULTS, parallel: "9" } })).toEqual(["hostLoop"]);
    expect(launchIssues({ ...base, sourceRunner: "coolify-host-loop", hostLoop: { ...HOST_LOOP_FORM_DEFAULTS } })).toEqual([]);
    // the tuning only matters for the host-loop runner
    expect(launchIssues({ ...base, sourceRunner: "operator", hostLoop: { ...HOST_LOOP_FORM_DEFAULTS, keyDir: "keys" } })).toEqual([]);
    expect(launchIssues({ ...base, deployConcurrency: "9" })).toEqual(["concurrency"]);
  });
  it("validates the pieces the way the hub does", () => {
    expect(validKeyDir("/data/coolify/ssh/keys")).toBe(true);
    expect(validKeyDir("/data/../etc")).toBe(false);
    expect(validKeyDir("/data/keys; rm")).toBe(false);
    expect(validKeyDir("relative/path")).toBe(false);
    expect(validCampaign("wave 1")).toBe(true);
    expect(validCampaign("")).toBe(false);
    expect(validCampaign("a\u0007b")).toBe(false);
    expect(validDigest(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(validDigest(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(validDigest("sha256:abc")).toBe(false);
    expect(validImageRef("repo/app:latest")).toBe(true);
    expect(validImageRef("bad image")).toBe(false);
    expect(validAppItemRef("app:host-a:web-1")).toBe(true);
    expect(validAppItemRef("database:host-a:db")).toBe(false);
  });
});

describe("run list helpers", () => {
  it("counts extra target servers for the title", () => {
    expect(runTitleParts({ sourceHost: "h", sourceKind: "coolify", targetServerName: "t", targetServerId: "s", targetServerCount: 3 })).toEqual({ source: "h", target: "t", extraTargets: 2 });
    expect(runTitleParts({ sourceHost: null, sourceKind: "coolify", targetServerName: null, targetServerId: "s" })).toEqual({ source: "coolify", target: "s", extraTargets: 0 });
  });
  it("rolls the runs of a campaign up so the parts always add up to the total, and skips runs with no campaign", () => {
    const rows = [
      { campaign: "wave-2", status: "COMPLETED" as const },
      { campaign: "wave-2", status: "WAITING" as const },
      { campaign: "wave-2", status: "ABORTED" as const },
      { campaign: "wave-2", status: "DRY_RUN_DONE" as const },
      { campaign: "wave-2", status: "FAILED" as const },
      { campaign: "wave-2", status: "ROLLED_BACK" as const },
      { campaign: "wave-1", status: "RUNNING" as const },
      { campaign: null, status: "RUNNING" as const },
    ];
    expect(campaignRollup(rows)).toEqual([
      { campaign: "wave-1", total: 1, completed: 0, live: 1, failed: 0, other: 0 },
      { campaign: "wave-2", total: 6, completed: 1, live: 1, failed: 1, other: 3 },
    ]);
    for (const c of campaignRollup(rows)) expect(c.completed + c.live + c.failed + c.other).toBe(c.total);
  });
  it("words the evidence kinds: the two newer kinds are never drawn like a hub-verified one", () => {
    expect(evidenceTone("hub-verified")).toBe("ok");
    expect(evidenceTone("operator-attested")).toBe("muted");
    expect(evidenceTone("source-api-reported")).toBe("warn");
    expect(evidenceTone("host-loop-reported")).toBe("warn");
  });
  it("knows when a run can no longer take safety facts", () => {
    expect(hintsClosed({ status: "WAITING", ponrAt: null })).toBe(false);
    expect(hintsClosed({ status: "DRY_RUN_DONE", ponrAt: null })).toBe(false);
    expect(hintsClosed({ status: "WAITING", ponrAt: "2026-11-16T10:00:00Z" })).toBe(true);
    expect(hintsClosed({ status: "COMPLETED", ponrAt: null })).toBe(true);
  });
});

describe("source hosts by name (placement)", () => {
  const items = [
    { itemRef: "app:aaaa-1111:web", kind: "app" as const },
    { itemRef: "app:bbbb-2222:api", kind: "app" as const },
    { itemRef: "app:_:orphan", kind: "app" as const },
  ];
  it("attaches the name the plan gives each host and sorts the hosts by name, the unknown host last", () => {
    const rows = sourceServersOf(items, [{ ref: "aaaa-1111", name: "zeta-host" }, { ref: "bbbb-2222", name: "Alpha-host" }, { ref: "cccc-3333", name: "unused" }]);
    expect(rows.map((r) => [r.ref, r.name])).toEqual([["bbbb-2222", "Alpha-host"], ["aaaa-1111", "zeta-host"], ["_", undefined]]);
    // no names, or an empty one: the ref stays the label
    expect(sourceServersOf(items, [{ ref: "aaaa-1111", name: "  " }, { ref: "bbbb-2222" }]).every((r) => r.name === undefined)).toBe(true);
  });
  it("reads the names PREFLIGHT recorded and labels a host with its name, else its uuid", () => {
    const run = {
      steps: [{ key: "PREFLIGHT", gate: { passed: true, checks: [{ id: "preflight.hosts", status: "pass", code: "preflight.hosts-classified", params: { refs: ["aaaa-1111", "bbbb-2222", "__proto__"], names: ["host-1", "", "evil"] } }] } }],
    } as never;
    const names = sourceHostNames(run);
    expect(names).toEqual({ "aaaa-1111": "host-1", ["__proto__"]: "evil" });
    expect(sourceHostLabel(names, "aaaa-1111")).toBe("host-1");
    expect(sourceHostLabel(names, "bbbb-2222")).toBe("bbbb-2222");
    expect(sourceHostLabel(names, "constructor")).toBe("constructor"); // never resolved through the prototype
    expect(sourceHostNames({ steps: [] } as never)).toEqual({});
  });
});

describe("held workers (R26)", () => {
  const withCheck = (params: Record<string, unknown> | null) =>
    ({ steps: [{ key: "PREFLIGHT", gate: { passed: true, checks: params ? [{ id: "preflight.workers", status: "pass", code: "preflight.workers-held", params }] : [] } }] }) as never;
  it("lists every worker of the PREFLIGHT check with the policy, not just the ten of its sentence", () => {
    const names = Array.from({ length: 14 }, (_, i) => `worker-${i}`);
    expect(heldWorkersOf(withCheck({ count: 14, items: names.slice(0, 10), workers: names, policy: "hold-dark" }))).toEqual({ policy: "hold-dark", count: 14, names });
    expect(heldWorkersOf(withCheck({ count: 1, workers: ["w"], policy: "start-dark" }))?.policy).toBe("start-dark");
    expect(heldWorkersOf(withCheck({ count: 1, workers: ["w"], policy: "exclude" }))?.policy).toBe("exclude");
    expect(heldWorkersOf(withCheck({ count: 1, workers: ["w"] }))?.policy).toBe("hold-dark");
  });
  it("is null when there is no worker, no list (an older run) or no PREFLIGHT gate", () => {
    expect(heldWorkersOf(withCheck(null))).toBeNull();
    expect(heldWorkersOf(withCheck({ count: 2, items: ["a", "b"] }))).toBeNull();
    expect(heldWorkersOf(withCheck({ count: 0, workers: [] }))).toBeNull();
    expect(heldWorkersOf({ steps: [] } as never)).toBeNull();
  });
});

describe("campaign report (R15/R69)", () => {
  const run = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id, teamId: "t1", targetServerId: "srv1", targetServerName: "tugra-1", targetServerCount: 1, sourceKind: "coolify", sourceHost: "src.example.test", sourceVersion: null, campaign: "wave-1", mode: "copy", topology: "two-box", dryRun: false,
      status: "COMPLETED", currentStep: null, ponrAt: null, stepsPassed: 13, stepsTotal: 13, nextActionKind: "none", failure: null, createdAt: `2026-11-2${id.length}T10:00:00.000Z`, startedAt: null, finishedAt: null, ...over,
    }) as never;
  const report = (id: string, over: Record<string, unknown> = {}) =>
    ({
      runId: id, generatedAt: "2026-11-25T10:00:00.000Z", status: "COMPLETED", mode: "copy", topology: "two-box", dryRun: false, source: { kind: "coolify", host: "src.example.test" }, target: { serverId: "srv1", serverName: "tugra-1" },
      targets: [{ serverId: "srv1", serverName: "tugra-1" }, { serverId: "srv2", serverName: "tugra-2" }], ponrAt: null, window: { estimatedSec: 600, measuredSec: 420 }, steps: [], evidenceSummary: {}, manual: [],
      items: [{ kind: "app", name: "app-a", outcome: "moved", code: null, evidence: null }, { kind: "database", name: "db-a", outcome: "moved", code: null, evidence: null }, { kind: "app", name: "app-b", outcome: "not-cut-over", code: "cutover.host-held", evidence: null }], ...over,
    }) as never;

  it("rolls the runs up per state, with hosts, windows, item counts and the items that need attention", () => {
    const runs = [
      run("r1"),
      run("rr2", { status: "FAILED", sourceHost: "other.example.test", failure: { step: "DATA_FINAL", code: "data-final.host-failed" } }),
      run("rrr3", { status: "WAITING", currentStep: "VERIFY", campaign: "wave-2" }), // another campaign: left out
    ];
    const reports = new Map([
      ["r1", report("r1")],
      ["rr2", report("rr2", { window: { estimatedSec: 300, measuredSec: null }, items: [{ kind: "database", name: "db-b", outcome: "failed", code: "data.dump-too-big", evidence: null }] })],
    ]);
    const d = buildCampaignReport("wave-1", runs, reports);
    expect(d.runs.map((r) => r.id)).toEqual(["r1", "rr2"]);
    expect(d.rollup).toEqual({ total: 2, completed: 1, live: 0, failed: 1, other: 0 });
    expect(d.totals).toEqual({ moved: 2, skipped: 0, acked: 0, failed: 1, notCutOver: 1 });
    expect(d.runs[0]).toMatchObject({ targetNames: ["tugra-1", "tugra-2"], targetCount: 2, estimatedSec: 600, measuredSec: 420, items: { moved: 2, notCutOver: 1 } });
    expect(d.runs[0].problemItems).toEqual([{ kind: "app", name: "app-b", outcome: "not-cut-over", code: "cutover.host-held" }]);
    expect(d.runs[1]).toMatchObject({ failure: { step: "DATA_FINAL", code: "data-final.host-failed" }, measuredSec: null, problemItems: [{ name: "db-b", outcome: "failed", code: "data.dump-too-big" }] });
    expect(d.window).toEqual({ measuredTotalSec: 420, measuredLongestSec: 420, estimatedTotalSec: 900 });
    expect(d.sourceHosts).toEqual(["other.example.test", "src.example.test"]);
    expect(d.targetServers).toEqual(["tugra-1", "tugra-2"]);
    expect(d.pendingReports).toBe(0);
  });

  it("a run whose report is not loaded still has its row; one that could not be read is not pending", () => {
    const d = buildCampaignReport("wave-1", [run("r1"), run("rr2")], new Map<string, never | null | undefined>([["rr2", null]]));
    expect(d.runs.map((r) => [r.id, r.items])).toEqual([["r1", null], ["rr2", null]]);
    expect(d.runs[0]).toMatchObject({ targetNames: ["tugra-1"], targetCount: 1, measuredSec: null });
    expect(d.pendingReports).toBe(1);
    expect(d.window).toEqual({ measuredTotalSec: null, measuredLongestSec: null, estimatedTotalSec: null });
    expect(buildCampaignReport("none", [run("r1")], new Map()).runs).toEqual([]);
  });

  it("keeps at most twenty problem items per run and links the report with the label encoded", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ kind: "app", name: `a${i}`, outcome: "failed", code: null, evidence: null }));
    expect(buildCampaignReport("wave-1", [run("r1")], new Map([["r1", report("r1", { items })]])).runs[0].problemItems).toHaveLength(20);
    expect(campaignReportHref("wave 1/a")).toBe("/import/runs/campaign?c=wave%201%2Fa");
  });
});
