import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import apps from "../i18n/locales/en/apps.json";
import { ackLabelKey, ackPayload, bannerWorthy, canContinue, codeText, detailVars, fmtSeconds, isTerminalPhase, moveSteps, pollInterval, splitBlockers, targetChoices, volumeProgress, warningText } from "./app-move";
import type { AppMove, MoveAckKey, MovePreflightResult } from "./types";

const pf = (over: Partial<MovePreflightResult> = {}): MovePreflightResult => ({
  ok: true, blockers: [], warnings: [], requiredAcks: [],
  plan: { cheap: false, volumes: [], totalBytes: 0, partBytes: 1, estimatedParts: 0, sourceStagingFreeBytes: null, targetFreeBytes: null, estimatedDowntimeSec: { low: 1, high: 2 }, domain: { kind: "none", from: null, to: null }, hostPort: { from: null, to: null }, targetIp: null, link: null },
  ...over,
});

describe("moveSteps", () => {
  it("a running move marks the current step active and earlier ones done", () => {
    expect(moveSteps("TRANSFERRING", null).map((s) => s.state)).toEqual(["done", "done", "active", "pending", "pending"]);
    expect(moveSteps("QUEUED", null).map((s) => s.state)).toEqual(["pending", "pending", "pending", "pending", "pending"].map((_, i) => (i === 0 ? "pending" : "pending")));
  });
  it("COMPLETED is all done; a rolled-back / failed move marks the step it failed in", () => {
    expect(moveSteps("COMPLETED", null).every((s) => s.state === "done")).toBe(true);
    expect(moveSteps("ROLLED_BACK", "TRANSFERRING").map((s) => s.state)).toEqual(["done", "done", "failed", "pending", "pending"]);
    expect(moveSteps("FAILED", "DEPLOYING").map((s) => s.state)).toEqual(["done", "done", "done", "failed", "pending"]);
    expect(moveSteps("ROLLING_BACK", "PRECHECK").map((s) => s.state)[0]).toBe("failed");
  });
});

describe("gating", () => {
  it("Continue needs no hard blocker AND every required ack ticked", () => {
    const r = pf({ ok: false, blockers: [{ code: "host_mounts", message: "", ack: true }], requiredAcks: ["hostMounts", "domainChanges"] });
    expect(canContinue(r, {})).toBe(false);
    expect(canContinue(r, { hostMounts: true })).toBe(false);
    expect(canContinue(r, { hostMounts: true, domainChanges: true })).toBe(true);
    const hard = pf({ ok: false, blockers: [{ code: "agent_offline_target", message: "" }] });
    expect(canContinue(hard, {})).toBe(false);
    expect(canContinue(pf({ blockers: [{ code: "x", message: "" }, { code: "host_mounts", message: "", ack: true }], requiredAcks: ["hostMounts"] }), { hostMounts: true })).toBe(false); // a hard one remains
    expect(canContinue(undefined, {})).toBe(false);
    expect(canContinue(pf(), {})).toBe(true);
  });
  it("splitBlockers separates hard from acknowledgeable; ackPayload sends only ticked required acks", () => {
    const r = pf({ blockers: [{ code: "a", message: "" }, { code: "host_mounts", message: "", ack: true }], requiredAcks: ["hostMounts", "dropGpus"] });
    expect(splitBlockers(r)).toMatchObject({ hard: [{ code: "a" }], needsAck: [{ code: "host_mounts" }] });
    expect(ackPayload(r, { hostMounts: true, dropGpus: false, domainChanges: true })).toEqual({ hostMounts: true });
  });
});

describe("targetChoices", () => {
  const servers = [
    { id: "s1", name: "alpha", status: "ONLINE", teamId: "t1" },
    { id: "s2", name: "beta", status: "ONLINE", teamId: "t1" },
    { id: "s3", name: "gamma", status: "OFFLINE", teamId: "t1" },
    { id: "s4", name: "other-team", status: "ONLINE", teamId: "t2" },
    { id: "s5", name: "fresh", status: "PENDING", teamId: "t1" },
  ] as never;
  it("same team only, the current server excluded, offline/pending ones disabled with the reason", () => {
    const c = targetChoices(servers, "s1", "t1", { offline: "offline" });
    expect(c.map((x) => [x.value, x.disabled, x.label])).toEqual([["s2", false, "beta"], ["s3", true, "gamma (offline)"], ["s5", true, "fresh (offline)"]]);
  });
});

describe("misc helpers", () => {
  it("fmtSeconds / pollInterval / volumeProgress", () => {
    expect(fmtSeconds(45)).toBe("45s");
    expect(fmtSeconds(200)).toBe("3m 20s");
    expect(fmtSeconds(180)).toBe("3m");
    expect(fmtSeconds(7500)).toBe("2h 5m");
    expect([0, 1, 2, 3, 10].map(pollInterval)).toEqual([2000, 4000, 8000, 16000, 30000]);
    expect(volumeProgress({ parts: 4, partsDone: 1, sizeBytes: 10, bytesDone: 0 })).toBe(0.25);
    expect(volumeProgress({ parts: 0, partsDone: 0, sizeBytes: 10, bytesDone: 5 })).toBe(0.5);
    expect(volumeProgress({ parts: 0, partsDone: 0, sizeBytes: null, bytesDone: 0 })).toBe(0);
    expect(isTerminalPhase("COMPLETED") && isTerminalPhase("ROLLED_BACK") && isTerminalPhase("FAILED")).toBe(true);
    expect(isTerminalPhase("DEPLOYING")).toBe(false);
  });

  it("bannerWorthy: live moves, an unresolved FAILED, an unpurged archive, a recent terminal move", () => {
    const mv = (o: Partial<AppMove>): AppMove => ({ phase: "COMPLETED", finishedAt: new Date().toISOString(), archiveUntil: null, sourcePurgedAt: null, needsAttention: false, ...o }) as AppMove;
    expect(bannerWorthy(undefined)).toBe(false);
    expect(bannerWorthy(mv({ phase: "TRANSFERRING" }))).toBe(true);
    expect(bannerWorthy(mv({ phase: "FAILED", needsAttention: true, finishedAt: "2020-01-01T00:00:00Z" }))).toBe(true);
    expect(bannerWorthy(mv({ phase: "FAILED", needsAttention: false }))).toBe(false);
    expect(bannerWorthy(mv({ archiveUntil: new Date(Date.now() + 86400000).toISOString(), finishedAt: "2020-01-01T00:00:00Z" }))).toBe(true);
    expect(bannerWorthy(mv({ phase: "ROLLED_BACK", finishedAt: "2020-01-01T00:00:00Z" }))).toBe(false);
    expect(bannerWorthy(mv({ phase: "ROLLED_BACK" }))).toBe(true);
    expect(bannerWorthy(mv({ phase: "ROLLED_BACK", finishedAt: "2020-01-01T00:00:00Z", snapshotKept: true }))).toBe(true); // a kept recovery copy waits for the operator
  });

  it("warningText drops the key list for the env warning when the hub withheld it", () => {
    const t = (k: string, v?: Record<string, string | number>) => (k === "apps.moveWarn_env_may_reference_old_host" ? `with ${v?.keys}` : k === "apps.moveWarn_env_may_reference_old_host_nokeys" ? "no keys" : k);
    expect(warningText(t, { code: "env_may_reference_old_host", details: { keys: ["A", "B"] } })).toBe("with A, B");
    expect(warningText(t, { code: "env_may_reference_old_host" })).toBe("no keys");
  });

  it("codeText falls back to the hub's own message (then the raw code) for an unknown code; detailVars flattens arrays", () => {
    const t = (k: string) => k; // a translator that has no key
    expect(codeText(t, "Blocker", "brand_new", "Hub says so")).toBe("Hub says so");
    expect(codeText(t, "Blocker", "brand_new")).toBe("brand_new");
    const known = (k: string, v?: Record<string, string | number>) => (k === "apps.moveWarn_x" ? `hi ${v?.n}` : k);
    expect(codeText(known, "Warn", "x", "", { n: 3 })).toBe("hi 3");
    expect(detailVars({ keys: ["A", "B"], count: 2, nested: { a: 1 }, ip: "1.2.3.4" })).toEqual({ keys: "A, B", count: 2, ip: "1.2.3.4" });
  });
});

// ── i18n coverage: the shared code lists are the single source of truth; the web has no link to @tugra/shared, so (like
// the file-manager test) read the closed lists straight from its source. ──
describe("every shared move code has an i18n key", () => {
  const shared = readFileSync(path.resolve(__dirname, "../../../../packages/shared/src/app-move.ts"), "utf8");
  const list = (name: string): string[] => {
    const body = new RegExp(`${name} = \\[([\\s\\S]*?)\\] as const`).exec(shared)![1];
    return [...body.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  };
  const ackBlockers = [...new RegExp("APP_MOVE_ACK_BLOCKERS = \\{([\\s\\S]*?)\\}").exec(shared)![1].matchAll(/([a-z_]+):/g)].map((m) => m[1]);
  const A = apps as unknown as Record<string, string>;

  it("blockers (including the acknowledgement ones)", () => {
    const codes = [...list("APP_MOVE_BLOCKER_CODES"), ...ackBlockers];
    expect(codes.length).toBeGreaterThan(30);
    expect(ackBlockers).toHaveLength(7);
    for (const c of new Set(codes)) expect(typeof A[`moveBlocker_${c}`], `moveBlocker_${c}`).toBe("string");
  });
  it("warnings", () => {
    const codes = list("APP_MOVE_WARNING_CODES");
    expect(codes.length).toBeGreaterThan(20);
    for (const c of codes) expect(typeof A[`moveWarn_${c}`], `moveWarn_${c}`).toBe("string");
  });
  it("failure reasons", () => {
    const codes = list("APP_MOVE_FAILURE_REASONS");
    expect(codes.length).toBe(24);
    for (const c of codes) expect(typeof A[`moveErr_${c}`], `moveErr_${c}`).toBe("string");
  });
  it("phases, acknowledgements and the deployment-trigger / rollback labels", () => {
    for (const p of list("APP_MOVE_PHASES")) expect(typeof A[`movePhase_${p}`], `movePhase_${p}`).toBe("string");
    const acks = list("APP_MOVE_ACKS");
    expect(acks).toHaveLength(7);
    for (const a of acks) expect(typeof A[ackLabelKey(a as MoveAckKey).replace("apps.", "")], ackLabelKey(a as MoveAckKey)).toBe("string");
    for (const k of ["trigger_move", "rollbackPredatesMove", "moveLockedTooltip", "moveStep_target", "moveStep_review", "moveStep_confirm", "moveStep_progress"]) expect(typeof A[k], k).toBe("string");
  });
});
