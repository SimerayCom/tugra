import { MigrationRunStatus, MigrationRunStepStatus } from "@prisma/client";
import {
  ENGINE_EVENT_CODES,
  LIVE_RUN_STATUSES,
  OWNER_INPUT_DEFAULTS,
  OWNER_INPUT_KEYS,
  RUN_STATUSES,
  STEP_KEYS,
  STEP_MANIFEST,
  STEP_STATUSES,
  StepFailure,
  TERMINAL_RUN_STATUSES,
  activeKeyFor,
  gateOnlyUnknown,
  isRunCode,
  isStepKey,
  isTerminalRunStatus,
  makeGate,
  resolveOwnerInput,
  runActorFromAuth,
  stepIndex,
  stepKeysForMode,
  type AnyStepHandler,
  type StepHandler,
  type StepKey,
} from "./run-contract";
import type { GateCheck, OwnerInputs } from "./dto";
import { StepHandlerRegistryService } from "./step-handler.registry";

const chk = (status: GateCheck["status"], extra: Partial<GateCheck> = {}): GateCheck => ({ id: "c", status, code: "x.y", ...extra });

/** A conforming handler: compiles only if the StepHandler contract is satisfied as documented. */
function handlerFor(key: StepKey, over: Partial<AnyStepHandler> = {}): AnyStepHandler {
  const m = STEP_MANIFEST[key];
  const h: StepHandler = {
    key,
    kind: m.kind,
    rollback: m.rollback,
    ...(m.skippable ? { skippable: true } : {}),
    applicable: () => true,
    dryRun: async () => [{ code: "x.info", level: "info" }],
    observe: async () => ({}),
    preGate: () => makeGate([]),
    act: async () => ({ outcome: "done" }),
    postGate: () => makeGate([chk("fail")]),
    compensate: async () => ({ outcome: "nothing-to-do" }),
    ...over,
  };
  return h;
}

describe("vocabulary parity with the Prisma enums", () => {
  it("RUN_STATUSES equals MigrationRunStatus", () => {
    expect([...RUN_STATUSES].sort()).toEqual(Object.values(MigrationRunStatus).sort());
  });
  it("STEP_STATUSES equals MigrationRunStepStatus", () => {
    expect([...STEP_STATUSES].sort()).toEqual(Object.values(MigrationRunStepStatus).sort());
  });
  it("live and terminal statuses partition the run statuses (FAILED live, ABORTED terminal)", () => {
    expect([...LIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES].sort()).toEqual([...RUN_STATUSES].sort());
    expect(LIVE_RUN_STATUSES).toContain("FAILED");
    expect(isTerminalRunStatus("ABORTED")).toBe(true);
    expect(isTerminalRunStatus("PAUSED")).toBe(false);
  });
});

describe("step manifest", () => {
  it("has an entry per key, indexed in order, matching the 13+1 step graph", () => {
    expect(STEP_KEYS).toHaveLength(14);
    STEP_KEYS.forEach((k, i) => expect(STEP_MANIFEST[k].idx).toBe(i));
    expect(stepIndex("CUTOVER")).toBe(10);
    expect(STEP_KEYS.slice(0, 13)).toEqual(["PREFLIGHT", "IMPORT", "DNS_PREPARE", "DATA_SEED", "FREEZE", "DATA_FINAL", "REMAP_ENV", "DEPLOY_DARK", "TLS_PREISSUE", "VERIFY", "CUTOVER", "OBSERVE", "FINALIZE"]);
  });
  it("only CUTOVER is the point of no return; only DECOMMISSION is manual; only DATA_SEED is skippable", () => {
    expect(STEP_KEYS.filter((k) => STEP_MANIFEST[k].ponr)).toEqual(["CUTOVER"]);
    expect(STEP_KEYS.filter((k) => STEP_MANIFEST[k].manual)).toEqual(["DECOMMISSION"]);
    expect(STEP_KEYS.filter((k) => STEP_MANIFEST[k].skippable)).toEqual(["DATA_SEED"]);
  });
  it("rollback classes follow the design table", () => {
    expect(STEP_MANIFEST.PREFLIGHT.rollback).toBe("FREE");
    expect(STEP_MANIFEST.VERIFY.rollback).toBe("FREE");
    expect(STEP_MANIFEST.CUTOVER.rollback).toBe("LOSSY_AFTER_PONR");
    expect(STEP_MANIFEST.OBSERVE.rollback).toBe("LOSSY_AFTER_PONR");
    expect(STEP_MANIFEST.FINALIZE.rollback).toBe("IRREVERSIBLE");
    for (const k of ["IMPORT", "DNS_PREPARE", "DATA_SEED", "FREEZE", "DATA_FINAL", "REMAP_ENV", "DEPLOY_DARK", "TLS_PREISSUE"] as const) expect(STEP_MANIFEST[k].rollback).toBe("UNDOABLE");
  });
  it("lane ownership matches the build plan", () => {
    const lane = (l: "A" | "B" | "C") => STEP_KEYS.filter((k) => STEP_MANIFEST[k].lane === l);
    expect(lane("A")).toEqual(["PREFLIGHT", "IMPORT", "REMAP_ENV", "DEPLOY_DARK"]);
    expect(lane("B")).toEqual(["DATA_SEED", "FREEZE", "DATA_FINAL", "VERIFY"]);
    expect(lane("C")).toEqual(["DNS_PREPARE", "TLS_PREISSUE", "CUTOVER", "OBSERVE", "FINALIZE", "DECOMMISSION"]);
  });
  it("DECOMMISSION has a step row only for takeover runs", () => {
    expect(stepKeysForMode("copy")).toHaveLength(13);
    expect(stepKeysForMode("copy")).not.toContain("DECOMMISSION");
    expect(stepKeysForMode("takeover")).toHaveLength(14);
  });
  it("isStepKey and activeKeyFor", () => {
    expect(isStepKey("FREEZE")).toBe(true);
    expect(isStepKey("freeze")).toBe(false);
    expect(activeKeyFor("srv1")).toBe("srv:srv1");
  });
  it("engine event codes are valid codes", () => {
    for (const c of ENGINE_EVENT_CODES) expect(isRunCode(c)).toBe(true);
  });
});

describe("makeGate", () => {
  it("passes with no checks and with pass/warn", () => {
    expect(makeGate([]).passed).toBe(true);
    expect(makeGate([chk("pass"), chk("warn")]).passed).toBe(true);
  });
  it("fail blocks unless acked", () => {
    expect(makeGate([chk("fail")]).passed).toBe(false);
    expect(makeGate([chk("fail", { ackable: true, acked: true })]).passed).toBe(true);
  });
  it("unknown fails by default (vx-gates rule) and only passes when explicitly allowed", () => {
    expect(makeGate([chk("unknown")]).passed).toBe(false);
    expect(makeGate([chk("unknown")], { unknownFails: false }).passed).toBe(true);
  });
  it("carries the wait only when it blocks", () => {
    const wait = { kind: "operator", code: "x.y" } as const;
    expect(makeGate([chk("fail")], { wait }).wait).toEqual(wait);
    expect(makeGate([chk("pass")], { wait }).wait).toBeUndefined();
  });
  it("gateOnlyUnknown distinguishes re-check from fix", () => {
    expect(gateOnlyUnknown(makeGate([chk("unknown")]))).toBe(true);
    expect(gateOnlyUnknown(makeGate([chk("unknown"), chk("fail")]))).toBe(false);
    expect(gateOnlyUnknown(makeGate([chk("pass")]))).toBe(false);
  });
});

describe("StepFailure and codes", () => {
  it("carries a code, params and retryable flag", () => {
    const f = new StepFailure("import.plan-drift", { items: 2 }, true);
    expect(f).toBeInstanceOf(Error);
    expect([f.code, f.params, f.retryable]).toEqual(["import.plan-drift", { items: 2 }, true]);
  });
  it("rejects a malformed code (no free text can ride the failure channel)", () => {
    expect(() => new StepFailure("Plan drifted!")).toThrow();
    expect(isRunCode("preflight.agent-offline")).toBe(true);
    expect(isRunCode("Has Space")).toBe(false);
    expect(isRunCode("x".repeat(81))).toBe(false);
  });
});

describe("owner inputs", () => {
  const now = "2026-11-23T00:00:00.000Z";
  it("covers the four run-level owner questions", () => {
    expect([...OWNER_INPUT_KEYS]).toEqual(["acmeEmail", "allowBind", "allowLiveShapeProbe", "sourceController"]);
  });
  it("an unanswered input resolves to its documented default; acmeEmail has none", () => {
    const empty: OwnerInputs = {};
    expect(resolveOwnerInput(empty, "allowBind")).toBe(false);
    expect(resolveOwnerInput(empty, "sourceController")).toBe("manual");
    expect(resolveOwnerInput(empty, "allowLiveShapeProbe")).toBe(false);
    expect(resolveOwnerInput(empty, "acmeEmail")).toBeUndefined();
    expect(OWNER_INPUT_DEFAULTS).toEqual({ allowBind: false, allowLiveShapeProbe: false, sourceController: "manual" });
  });
  it("an answered value wins; the literal unknown falls back to the default", () => {
    const inputs: OwnerInputs = {
      acmeEmail: { value: "ops@example.com", source: "request", setBy: "u1", at: now },
      sourceController: { value: "api", source: "request", setBy: "u1", at: now },
      allowBind: { value: "unknown", source: "request", setBy: "u1", at: now },
    };
    expect(resolveOwnerInput(inputs, "acmeEmail")).toBe("ops@example.com");
    expect(resolveOwnerInput(inputs, "sourceController")).toBe("api");
    expect(resolveOwnerInput(inputs, "allowBind")).toBe(false);
  });
});

describe("runActorFromAuth", () => {
  it("a PAT carries a tokenId, a browser session does not", () => {
    expect(runActorFromAuth({ userId: "u", scopes: ["deploy"], tokenId: "t" })).toEqual({ userId: "u", scopes: ["deploy"], channel: "pat" });
    expect(runActorFromAuth({ userId: "u", scopes: ["*"] }).channel).toBe("session");
  });
});

describe("StepHandlerRegistryService", () => {
  it("registers handlers and lists them in step order regardless of registration order", () => {
    const r = new StepHandlerRegistryService();
    r.register(handlerFor("CUTOVER"));
    r.register(handlerFor("PREFLIGHT"));
    r.register(handlerFor("DATA_SEED"));
    expect(r.list().map((h) => h.key)).toEqual(["PREFLIGHT", "DATA_SEED", "CUTOVER"]);
    expect(r.get("PREFLIGHT")?.key).toBe("PREFLIGHT");
    expect(r.get("IMPORT")).toBeUndefined();
    expect(() => r.require("IMPORT")).toThrow(/no handler/);
  });
  it("reports missing steps per mode (DECOMMISSION only for takeover)", () => {
    const r = new StepHandlerRegistryService();
    for (const k of stepKeysForMode("copy")) r.register(handlerFor(k));
    expect(r.missing("copy")).toEqual([]);
    expect(r.missing("takeover")).toEqual(["DECOMMISSION"]);
    expect(r.missing()).toEqual(["DECOMMISSION"]);
  });
  it("rejects duplicates, unknown keys and manifest drift", () => {
    const r = new StepHandlerRegistryService();
    r.register(handlerFor("IMPORT"));
    expect(() => r.register(handlerFor("IMPORT"))).toThrow(/twice/);
    expect(() => r.register(handlerFor("PREFLIGHT", { key: "NOPE" as StepKey }))).toThrow(/unknown step key/);
    expect(() => r.register(handlerFor("FREEZE", { kind: "auto" }))).toThrow(/kind/);
    expect(() => r.register(handlerFor("CUTOVER", { rollback: "UNDOABLE" }))).toThrow(/rollback/);
    expect(() => r.register(handlerFor("DATA_SEED", { skippable: false }))).toThrow(/skippable/);
    expect(() => r.register(handlerFor("FINALIZE", { skippable: true }))).toThrow(/skippable/);
  });
});
