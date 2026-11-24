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
  COMMAND_KINDS,
  CONFIRM_KINDS,
  EVIDENCE_KINDS,
  HOST_LOOP_DEFAULTS,
  SERVER_MAP_MAX,
  SOURCE_RUNNERS,
  SOURCE_VERSION_SUPPORT,
  activeKeyFor,
  classifySourceVersion,
  compareSourceVersions,
  confirmServerNames,
  deployConcurrencyOf,
  gateOnlyUnknown,
  hostLoopOf,
  hostLoopTargets,
  isMultiTarget,
  largeDbModeOf,
  lockServerIdsFor,
  parseSourceVersion,
  targetServerFor,
  targetServerIdsOf,
  unmappedSourceServers,
  upgradeConfirmKind,
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
  it("covers the run-level owner questions (the original four first, grup-7 additions after)", () => {
    expect([...OWNER_INPUT_KEYS]).toEqual(["acmeEmail", "allowBind", "allowLiveShapeProbe", "sourceController", "minioPolicy", "tickGapAcceptMinutes", "workerPolicy", "unlistedDbPolicy", "orphanVolumePolicy"]);
  });
  it("every grup-7 default is fail-closed", () => {
    const empty: OwnerInputs = {};
    expect(resolveOwnerInput(empty, "minioPolicy")).toBe("hold"); // dependents stay on the source
    expect(resolveOwnerInput(empty, "tickGapAcceptMinutes")).toBe(0); // no write gap accepted
    expect(resolveOwnerInput(empty, "workerPolicy")).toBe("hold-dark"); // workers stay stopped until after CUTOVER
    expect(resolveOwnerInput(empty, "unlistedDbPolicy")).toBe("block");
    expect(resolveOwnerInput(empty, "orphanVolumePolicy")).toBe("block");
    // an answered 0 is a real answer, not "unknown"
    const answered: OwnerInputs = { tickGapAcceptMinutes: { value: 15, source: "request", setBy: "u1", at: now }, minioPolicy: { value: "unknown", source: "request", setBy: "u1", at: now } };
    expect(resolveOwnerInput(answered, "tickGapAcceptMinutes")).toBe(15);
    expect(resolveOwnerInput(answered, "minioPolicy")).toBe("hold");
  });
  it("an unanswered input resolves to its documented default; acmeEmail has none", () => {
    const empty: OwnerInputs = {};
    expect(resolveOwnerInput(empty, "allowBind")).toBe(false);
    expect(resolveOwnerInput(empty, "sourceController")).toBe("manual");
    expect(resolveOwnerInput(empty, "allowLiveShapeProbe")).toBe(false);
    expect(resolveOwnerInput(empty, "acmeEmail")).toBeUndefined();
    expect(OWNER_INPUT_DEFAULTS).toEqual({
      allowBind: false,
      allowLiveShapeProbe: false,
      sourceController: "manual",
      minioPolicy: "hold",
      tickGapAcceptMinutes: 0,
      workerPolicy: "hold-dark",
      unlistedDbPolicy: "block",
      orphanVolumePolicy: "block",
    });
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

describe("multi-host runs (serverMap helpers)", () => {
  const single = { targetServerId: "t-default" };
  const multi = { targetServerId: "t-default", serverMap: { "src-a": "t-1", "src-b": "t-2", "src-c": "t-1" } };

  it("a single-target run resolves every source server to the default", () => {
    expect(targetServerFor(single, "src-a")).toBe("t-default");
    expect(targetServerFor({ ...single, serverMap: {} }, "src-a")).toBe("t-default");
    expect(targetServerFor({ ...single, serverMap: null }, undefined)).toBe("t-default");
    expect(targetServerIdsOf(single)).toEqual(["t-default"]);
    expect(isMultiTarget(single)).toBe(false);
  });
  it("a mapped source resolves to its target, an unmapped or empty ref falls back to the default", () => {
    expect(targetServerFor(multi, "src-a")).toBe("t-1");
    expect(targetServerFor(multi, "src-b")).toBe("t-2");
    expect(targetServerFor(multi, "src-z")).toBe("t-default");
    expect(targetServerFor(multi, null)).toBe("t-default");
    expect(targetServerFor(multi, "")).toBe("t-default");
  });
  it("prototype names never resolve through the prototype chain", () => {
    for (const ref of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect(targetServerFor(multi, ref)).toBe("t-default");
  });
  it("target servers are the default first, then each mapped one once, in map order", () => {
    expect(targetServerIdsOf(multi)).toEqual(["t-default", "t-1", "t-2"]);
    expect(targetServerIdsOf({ targetServerId: "t-1", serverMap: { x: "t-1", y: "t-2" } })).toEqual(["t-1", "t-2"]);
    expect(isMultiTarget(multi)).toBe(true);
    expect(isMultiTarget({ targetServerId: "t-1", serverMap: { x: "t-1" } })).toBe(false);
  });
  it("a real run locks every target server, a dry-run none", () => {
    expect(lockServerIdsFor(multi, false)).toEqual(["t-default", "t-1", "t-2"]);
    expect(lockServerIdsFor(multi, true)).toEqual([]);
    expect(lockServerIdsFor(single, false)).toEqual(["t-default"]);
    expect(activeKeyFor("t-default")).toBe("srv:t-default");
  });
  it("hostLoopTargets lists the mapped hosts in map order (nothing for a single-target run)", () => {
    expect(hostLoopTargets(multi)).toEqual([
      { sourceServerRef: "src-a", targetServerId: "t-1" },
      { sourceServerRef: "src-b", targetServerId: "t-2" },
      { sourceServerRef: "src-c", targetServerId: "t-1" },
    ]);
    expect(hostLoopTargets(single)).toEqual([]);
  });
  it("unmappedSourceServers names the sources a non-empty map misses; an empty map misses none", () => {
    expect(unmappedSourceServers(multi, ["src-a", "src-z", "src-z", "src-y"])).toEqual(["src-z", "src-y"]);
    expect(unmappedSourceServers(single, ["src-z"])).toEqual([]);
    expect(unmappedSourceServers({ ...single, serverMap: {} }, ["src-z"])).toEqual([]);
  });
  it("the typed confirmation text is the distinct server names, sorted, comma-joined", () => {
    expect(confirmServerNames(["host-b", "host-a", "host-b"])).toBe("host-a, host-b");
    expect(confirmServerNames(["only"])).toBe("only");
    expect(confirmServerNames(["b", "a"])).toBe(confirmServerNames(["a", "b"]));
  });
  it("a single-server confirm kind is upgraded only for a multi-host run", () => {
    expect(upgradeConfirmKind("target-server", 1)).toBe("target-server");
    expect(upgradeConfirmKind("target-server", 3)).toBe("target-servers");
    expect(upgradeConfirmKind("target-server+source-host", 2)).toBe("target-servers+source-host");
    expect(upgradeConfirmKind("run-id", 3)).toBe("run-id");
    expect(upgradeConfirmKind("source-host", 3)).toBe("source-host");
    for (const k of ["target-servers", "target-servers+source-host"] as const) expect(CONFIRM_KINDS).toContain(k);
  });
  it("the map is bounded by SERVER_MAP_MAX", () => {
    expect(SERVER_MAP_MAX).toBe(64);
  });
});

describe("grup-7 vocabulary", () => {
  it("the host-loop runner joins operator and agent; the new command and evidence kinds are listed", () => {
    expect([...SOURCE_RUNNERS]).toEqual(["operator", "agent", "coolify-host-loop"]);
    expect([...COMMAND_KINDS]).toEqual(["migrator", "host-loop", "inventory"]);
    expect([...EVIDENCE_KINDS]).toEqual(["hub-verified", "migrator-reported", "operator-attested", "source-api-reported", "host-loop-reported"]);
  });
  it("the engine knows the source-version event", () => {
    expect(ENGINE_EVENT_CODES).toContain("run.source-version");
  });
  it("option resolvers fill the documented defaults", () => {
    expect(hostLoopOf({})).toEqual(HOST_LOOP_DEFAULTS);
    expect(hostLoopOf({ hostLoop: { keyDir: "/k", parallel: 3, connectTimeoutSec: 10, retries: 0 } })).toEqual({ keyDir: "/k", parallel: 3, connectTimeoutSec: 10, retries: 0 });
    expect(deployConcurrencyOf({})).toBe(1);
    expect(deployConcurrencyOf({ deployConcurrency: 4 })).toBe(4);
    expect(largeDbModeOf({})).toBe("stream-logical");
    expect(largeDbModeOf({ largeDbMode: "refuse" })).toBe("refuse");
    expect(largeDbModeOf({ largeDbMode: "stream-logical" })).toBe("stream-logical");
  });
});

describe("source version support (R4/C18)", () => {
  it("parses release, v-prefixed and pre-release strings; rejects junk", () => {
    expect(parseSourceVersion("4.1.2")).toEqual({ n: [4, 1, 2], pre: false });
    expect(parseSourceVersion("v4.7.5")).toEqual({ n: [4, 7, 5], pre: false });
    expect(parseSourceVersion("4.0.0-beta.442")).toEqual({ n: [4, 0, 0], pre: true });
    expect(parseSourceVersion("4.7")).toEqual({ n: [4, 7, 0], pre: false });
    for (const bad of ["", "latest", "4", "4.x.1", "4.1.2.3", "4.1.2 beta", null, undefined]) expect(parseSourceVersion(bad as string)).toBeNull();
  });
  it("compares numerically, a pre-release sorts before its release", () => {
    expect(compareSourceVersions("4.1.2", "4.1.2")).toBe(0);
    expect(compareSourceVersions("4.10.0", "4.9.9")).toBeGreaterThan(0);
    expect(compareSourceVersions("4.0.0-beta.442", "4.0.0")).toBeLessThan(0);
    expect(compareSourceVersions("nope", "4.0.0")).toBeNull();
  });
  it("classifies against the supported range: the fleet's 4.1.2 up to the tested 4.7.5", () => {
    expect(SOURCE_VERSION_SUPPORT.coolify).toEqual({ min: "4.1.2", maxTested: "4.7.5" });
    expect(classifySourceVersion("coolify", "4.1.2")).toBe("supported");
    expect(classifySourceVersion("coolify", "4.6.0")).toBe("supported");
    expect(classifySourceVersion("coolify", "4.7.5")).toBe("supported");
    expect(classifySourceVersion("coolify", "4.7.6")).toBe("newer");
    expect(classifySourceVersion("coolify", "5.0.0")).toBe("newer");
    expect(classifySourceVersion("coolify", "4.1.1")).toBe("too-old");
    expect(classifySourceVersion("coolify", "4.0.0-beta.442")).toBe("too-old");
  });
  it("an unknown or unreadable version is `unknown` (fails wherever data would move); a kind without a range is `unchecked`", () => {
    expect(classifySourceVersion("coolify", null)).toBe("unknown");
    expect(classifySourceVersion("coolify", "main")).toBe("unknown");
    expect(classifySourceVersion("dokploy", "0.30.10")).toBe("unchecked");
    expect(classifySourceVersion("dokploy", null)).toBe("unchecked");
  });
});
