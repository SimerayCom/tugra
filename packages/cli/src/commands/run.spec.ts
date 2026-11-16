import { Command } from "commander";
import { RUN_ACTIONS, buildCreateRequest, buildListRequest, buildRequest, confirmHint, formatEvent, formatStatus, isTerminal, register, watchRun, type RunView } from "./run";

const PLAN = "a".repeat(32);
const HASH = "b".repeat(64);
const create = { session: "s1", server: "srv1", planHash: PLAN };

const view = (over: Partial<RunView> = {}): RunView => ({
  id: "run1",
  status: "WAITING",
  currentStep: "FREEZE",
  mode: "copy",
  topology: "two-box",
  dryRun: false,
  ponrAt: null,
  targetServerName: "tugra-box",
  sourceHost: "coolify.example.com",
  failure: null,
  nextAction: { kind: "gate", stepKey: "FREEZE", code: "gate.blocked", since: "2026-11-22T01:00:00Z" },
  windowEstimate: null,
  measuredDowntimeSec: null,
  steps: [{ key: "PREFLIGHT", status: "PASSED", kind: "auto", attempt: 1, rollbackClass: "FREE", lastError: null, progress: null }],
  eventSeq: 4,
  ...over,
});

describe("tugra import run: create", () => {
  it("sends only what was asked for, so the hub applies its safe defaults", () => {
    expect(buildCreateRequest(create)).toEqual({ method: "POST", path: "/migration-runs", body: { sessionId: "s1", sourceKind: "coolify", targetServerId: "srv1", planHash: PLAN } });
  });

  it("maps every option and owner input onto the request schema's names", () => {
    const req = buildCreateRequest({
      ...create, sourceKind: "dokploy", environment: "env1", mode: "takeover", topology: "swap-proxy", dryRun: true,
      mapping: { version: 1 }, mappingHash: "c".repeat(32), acks: [{ code: "app.env.unresolved" }], dbDataModes: { "database:a:b": "volume" }, reconcile: true, saveMapping: false,
      ttlPolicy: "skip-ack", deployWaves: "earlyStateless", warmDbSeed: true, stopSource: true, sourceRunner: "agent", certs: "seed", acceptHttp01Gap: true,
      freezeAt: "2026-11-22T02:00:00Z", observeMinutes: 0, manualFinalize: true, batchSize: 3, interval: 60, dnsCredential: "dns1", healthPath: "/health",
      rowCountMode: "exact", decommissionMinAge: 96, stuckOperatorMinutes: 30, acmeEmail: "ops@example.com", allowBind: false, allowLiveProbe: true, sourceController: "api",
    });
    expect(req.body).toEqual({
      sessionId: "s1", sourceKind: "dokploy", targetServerId: "srv1", planHash: PLAN, environmentId: "env1", mode: "takeover", topology: "swap-proxy", dryRun: true,
      mapping: { version: 1 }, mappingHash: "c".repeat(32), acks: [{ code: "app.env.unresolved" }], dbDataModes: { "database:a:b": "volume" }, reconcile: true, saveMapping: false,
      options: {
        ttlPolicy: "skip-ack", deployWaves: "earlyStateless", warmDbSeed: true, stopSource: true, sourceRunner: "agent", certs: "seed", acceptHttp01Gap: true,
        freezeAt: "2026-11-22T02:00:00Z", observeMinutes: 0, manualFinalize: true, batchSize: 3, intervalSec: 60, dnsCredentialId: "dns1", healthPath: "/health",
        rowCountMode: "exact", decommissionMinAgeHours: 96, stuckOperatorMinutes: 30,
      },
      inputs: { acmeEmail: "ops@example.com", allowBind: false, allowLiveShapeProbe: true, sourceController: "api" },
    });
  });

  it("refuses bad input before any request is made", () => {
    expect(() => buildCreateRequest({ ...create, session: undefined })).toThrow(/--session/);
    expect(() => buildCreateRequest({ ...create, server: undefined })).toThrow(/--server/);
    expect(() => buildCreateRequest({ ...create, planHash: "xyz" })).toThrow(/--plan-hash/);
    expect(() => buildCreateRequest({ ...create, sourceKind: "nope" })).toThrow(/--source-kind/);
    expect(() => buildCreateRequest({ ...create, topology: "side-by-side" })).toThrow(/--topology/);
    expect(() => buildCreateRequest({ ...create, mode: "move" })).toThrow(/--mode/);
    expect(() => buildCreateRequest({ ...create, mapping: {} })).toThrow(/together/);
    expect(() => buildCreateRequest({ ...create, mappingHash: "c".repeat(32) })).toThrow(/together/);
    expect(() => buildCreateRequest({ ...create, batchSize: 99 })).toThrow(/--batch-size/);
    expect(() => buildCreateRequest({ ...create, observeMinutes: Number.NaN })).toThrow(/--observe-minutes/);
    expect(() => buildCreateRequest({ ...create, freezeAt: "tomorrow-ish" })).toThrow(/--freeze-at/);
    expect(() => buildCreateRequest({ ...create, healthPath: "health" })).toThrow(/--health-path/);
    expect(() => buildCreateRequest({ ...create, sourceController: "ssh" })).toThrow(/--source-controller/);
  });
});

describe("tugra import run: list, status, events", () => {
  it("builds the list query", () => {
    expect(buildListRequest({})).toEqual({ method: "GET", path: "/migration-runs" });
    expect(buildListRequest({ team: "t1", status: "WAITING", active: true, limit: 10 }).path).toBe("/migration-runs?teamId=t1&status=WAITING&active=true&limit=10");
    expect(() => buildListRequest({ limit: 500 })).toThrow(/--limit/);
  });

  it("status and events", () => {
    expect(buildRequest("status", "r 1", {})).toEqual({ method: "GET", path: "/migration-runs/r%201" });
    expect(buildRequest("events", "r1", {}).path).toBe("/migration-runs/r1/events");
    expect(buildRequest("events", "r1", { afterSeq: 12, limit: 50 }).path).toBe("/migration-runs/r1/events?afterSeq=12&limit=50");
    expect(() => buildRequest("events", "r1", { limit: 0 })).toThrow(/--limit/);
    expect(() => buildRequest("status", "", {})).toThrow(/run id/);
  });
});

describe("tugra import run: step actions", () => {
  it("approve carries the reviewed hash and what the human typed, and needs the hash", () => {
    expect(() => buildRequest("approve", "r1", { step: "FREEZE" })).toThrow(/--hash/);
    expect(() => buildRequest("approve", "r1", { step: "FREEZE", hash: "short" })).toThrow(/--hash/);
    expect(buildRequest("approve", "r1", { step: "FREEZE", hash: HASH })).toEqual({ method: "POST", path: "/migration-runs/r1/steps/FREEZE/approve", body: { boundHash: HASH, acks: [] } });
    expect(buildRequest("approve", "r1", { step: "VERIFY", hash: HASH, ack: "a, b", confirm: "tugra-box coolify.example.com", acceptDataRisk: true }).body).toEqual({
      boundHash: HASH, acks: ["a", "b"], confirmName: "tugra-box coolify.example.com", acceptDataRisk: true,
    });
  });

  it("every step action needs a step key and never builds a path from a malformed one", () => {
    for (const a of ["approve", "retry", "skip", "evidence", "attach", "command"] as const) {
      expect(() => buildRequest(a, "r1", { hash: HASH, check: "c", objectMigration: "o1" })).toThrow(/step key/);
      expect(() => buildRequest(a, "r1", { step: "../x", hash: HASH, check: "c", objectMigration: "o1" })).toThrow(/step key/);
    }
  });

  it("retry, skip, evidence, attach, command", () => {
    expect(buildRequest("retry", "r1", { step: "IMPORT" })).toEqual({ method: "POST", path: "/migration-runs/r1/steps/IMPORT/retry", body: {} });
    expect(buildRequest("skip", "r1", { step: "DATA_SEED", reason: "no data" }).body).toEqual({ reason: "no data" });
    expect(buildRequest("skip", "r1", { step: "DATA_SEED" }).body).toEqual({});
    expect(() => buildRequest("evidence", "r1", { step: "FREEZE" })).toThrow(/--check/);
    expect(buildRequest("evidence", "r1", { step: "FREEZE", check: "source.quiesced", subject: "srv", note: "stopped by hand" }).body).toEqual({ checkId: "source.quiesced", subject: "srv", note: "stopped by hand" });
    expect(() => buildRequest("attach", "r1", { step: "DATA_SEED" })).toThrow(/--object-migration/);
    expect(buildRequest("attach", "r1", { step: "DATA_SEED", objectMigration: "om1" }).body).toEqual({ kind: "object-migration", resourceId: "om1" });
    expect(buildRequest("command", "r1", { step: "DATA_FINAL" }).body).toEqual({ reissue: false });
    expect(buildRequest("command", "r1", { step: "DATA_FINAL", reissue: true }).body).toEqual({ reissue: true });
  });

  it("start promotes with an optional fresh session; pause and resume carry nothing", () => {
    expect(buildRequest("start", "r1", {})).toEqual({ method: "POST", path: "/migration-runs/r1/start", body: {} });
    expect(buildRequest("start", "r1", { session: "s2" }).body).toEqual({ sessionId: "s2" });
    expect(buildRequest("pause", "r1", {}).path).toBe("/migration-runs/r1/pause");
    expect(buildRequest("resume", "r1", {}).path).toBe("/migration-runs/r1/resume");
  });

  it("inputs needs at least one input and can send a false", () => {
    expect(() => buildRequest("inputs", "r1", {})).toThrow(/at least one/);
    expect(buildRequest("inputs", "r1", { allowBind: false, acmeEmail: "ops@example.com" })).toEqual({ method: "POST", path: "/migration-runs/r1/inputs", body: { acmeEmail: "ops@example.com", allowBind: false } });
    expect(() => buildRequest("inputs", "r1", { sourceController: "ssh" })).toThrow(/--source-controller/);
  });
});

describe("tugra import run: destructive actions", () => {
  it("abort, cleanup and reverse need the run id typed back", () => {
    for (const a of ["abort", "cleanup", "reverse"] as const) {
      expect(() => buildRequest(a, "r1", { acknowledgeDataLoss: true })).toThrow(/--confirm/);
      expect(() => buildRequest(a, "r1", { confirm: "r2", acknowledgeDataLoss: true })).toThrow(/--confirm/);
    }
    expect(buildRequest("abort", "r1", { confirm: "r1" })).toEqual({ method: "POST", path: "/migration-runs/r1/abort", body: { confirmName: "r1" } });
  });

  it("cleanup keeps data-bearing resources behind --include-data and their names", () => {
    expect(buildRequest("cleanup", "r1", { confirm: "r1" }).body).toEqual({ confirmName: "r1", includeData: false, dataConfirmNames: [] });
    expect(buildRequest("cleanup", "r1", { confirm: "r1", includeData: true, dataConfirm: "db1, vol1" }).body).toEqual({ confirmName: "r1", includeData: true, dataConfirmNames: ["db1", "vol1"] });
    expect(() => buildRequest("cleanup", "r1", { confirm: "r1", dataConfirm: "db1" })).toThrow(/--include-data/);
  });

  it("reverse needs the data-loss acknowledgement", () => {
    expect(() => buildRequest("reverse", "r1", { confirm: "r1" })).toThrow(/--acknowledge-data-loss/);
    expect(buildRequest("reverse", "r1", { confirm: "r1", acknowledgeDataLoss: true })).toEqual({ method: "POST", path: "/migration-runs/r1/reverse", body: { confirmName: "r1", acknowledgeDataLoss: true } });
  });

  it("decommission types the source host", () => {
    expect(() => buildRequest("decommission", "r1", {})).toThrow(/source host/);
    expect(buildRequest("decommission", "r1", { confirm: "coolify.example.com" }).body).toEqual({ confirmName: "coolify.example.com" });
  });

  it("source-session reads the token from the environment, never a flag, and the request carries it only in the body", () => {
    expect(() => buildRequest("source-session", "r1", {})).toThrow(/TUGRA_SOURCE_TOKEN/);
    const req = buildRequest("source-session", "r1", { token: "tok" });
    expect(req).toEqual({ method: "POST", path: "/migration-runs/r1/source-session", body: { token: "tok" } });
    expect(req.path).not.toContain("tok");
  });

  it("report: json by default, markdown on request", () => {
    expect(buildRequest("report", "r1", {}).path).toBe("/migration-runs/r1/report");
    expect(buildRequest("report", "r1", { format: "md" }).path).toBe("/migration-runs/r1/report?format=md");
    expect(() => buildRequest("report", "r1", { format: "pdf" })).toThrow(/--format/);
  });

  it("every action in the list builds a request (so none is registered without a builder)", () => {
    const o = { step: "FREEZE", hash: HASH, check: "c", objectMigration: "o1", confirm: "r1", acknowledgeDataLoss: true, token: "t", acmeEmail: "a@b.co" };
    for (const a of RUN_ACTIONS) expect(() => buildRequest(a, "r1", o)).not.toThrow();
  });
});

describe("rendering", () => {
  it("confirmHint names what the human must type", () => {
    const ctx = { runId: "r1", serverName: "tugra-box", sourceHost: "coolify.example.com" };
    expect(confirmHint("none", ctx)).toBeNull();
    expect(confirmHint("run-id", ctx)).toBe("r1");
    expect(confirmHint("target-server", ctx)).toBe("tugra-box");
    expect(confirmHint("source-host", ctx)).toBe("coolify.example.com");
    expect(confirmHint("target-server+source-host", ctx)).toBe("tugra-box coolify.example.com");
    expect(confirmHint("target-server", { ...ctx, serverName: null })).toBe("<target server name>");
  });

  it("formatEvent is one stable line with params", () => {
    expect(formatEvent({ seq: 7, at: "2026-11-22T02:00:00Z", stepKey: "FREEZE", level: "info", code: "step.started", params: { hosts: 3 } })).toBe(
      '   7 2026-11-22T02:00:00Z info  FREEZE        step.started {"hosts":3}',
    );
    expect(formatEvent({ seq: 8, at: "t", stepKey: null, level: "warn", code: "run.paused", params: null })).toContain("-             run.paused");
  });

  it("status prints the approval with the exact command, and says an agent cannot cross the point of no return", () => {
    const lines = formatStatus(
      view({
        currentStep: "VERIFY",
        nextAction: {
          kind: "approval", stepKey: "VERIFY", code: "approval.required", since: "t",
          approval: { inputHash: HASH, ponr: true, confirm: "target-server+source-host", ttlSec: 1800, requiresDataRisk: true, ackable: ["x"], requiredAcks: ["x"] },
        },
      }),
    ).join("\n");
    expect(lines).toContain(`tugra import run approve run1 VERIFY --hash ${HASH} --ack x --confirm "tugra-box coolify.example.com" --accept-data-risk`);
    expect(lines).toContain("POINT OF NO RETURN");
    expect(lines).toContain("valid for 30 min");
    expect(lines).toContain("point of no return: not reached");
  });

  it("status offers the source-host command and attestations on an operator wait, and shows the failure", () => {
    const lines = formatStatus(
      view({ failure: { step: "IMPORT", code: "import.failed" }, nextAction: { kind: "operator", stepKey: "DATA_FINAL", code: "data.run-migrator", since: "t", offersCommand: true, attest: ["source.quiesced"] } }),
    ).join("\n");
    expect(lines).toContain("tugra import run command run1 DATA_FINAL");
    expect(lines).toContain("source.quiesced");
    expect(lines).toContain("failed: import.failed at IMPORT");
    expect(lines).toContain("PREFLIGHT");
  });

  it("isTerminal", () => {
    for (const s of ["COMPLETED", "ABORTED", "ROLLED_BACK", "REVERSED", "DRY_RUN_DONE"]) expect(isTerminal(s)).toBe(true);
    for (const s of ["RUNNING", "WAITING", "PAUSED", "FAILED", "ABORTING"]) expect(isTerminal(s)).toBe(false);
  });
});

describe("watchRun", () => {
  const harness = (script: Array<{ events: Array<{ seq: number; code: string }>; view: Partial<RunView> }>) => {
    const written: string[] = [];
    const slept: number[] = [];
    const paths: string[] = [];
    let i = 0;
    let lastSeq = 0;
    return {
      written, slept, paths,
      deps: {
        write: (l: string) => void written.push(l),
        sleep: async (ms: number) => void slept.push(ms),
        get: async (p: string) => {
          paths.push(p);
          const step = script[Math.min(i, script.length - 1)];
          if (p.includes("/events")) {
            const events = step.events.map((e) => ({ ...e, at: "t", stepKey: null, level: "info", params: null }));
            if (events.length) lastSeq = events[events.length - 1].seq;
            return { events, lastSeq, hasMore: false };
          }
          i++;
          return view(step.view);
        },
      },
    };
  };

  it("prints each event once, follows the cursor and stops at a terminal status", async () => {
    const h = harness([
      { events: [{ seq: 1, code: "a" }, { seq: 2, code: "b" }], view: { status: "RUNNING", nextAction: { kind: "engine", stepKey: null, code: "x", since: "t" } } },
      { events: [{ seq: 3, code: "c" }], view: { status: "COMPLETED", nextAction: { kind: "none", stepKey: null, code: "x", since: "t" } } },
    ]);
    const v = await watchRun("r1", { interval: 2 }, h.deps);
    expect(v.status).toBe("COMPLETED");
    expect(h.written).toHaveLength(3);
    expect(h.paths.filter((p) => p.includes("/events")).map((p) => p.split("?")[1])).toEqual(["afterSeq=0&limit=500", "afterSeq=2&limit=500"]);
    expect(h.slept).toEqual([2000]);
  });

  it("with --until-waiting it returns when a human is needed, but keeps going through timers and engine work", async () => {
    const h = harness([
      { events: [], view: { status: "WAITING", nextAction: { kind: "timer", stepKey: "DNS_PREPARE", code: "t", since: "t" } } },
      { events: [], view: { status: "WAITING", nextAction: { kind: "engine", stepKey: null, code: "e", since: "t" } } },
      { events: [], view: { status: "WAITING", nextAction: { kind: "approval", stepKey: "FREEZE", code: "a", since: "t" } } },
    ]);
    const v = await watchRun("r1", { interval: 1, untilWaiting: true }, h.deps);
    expect(v.nextAction.kind).toBe("approval");
    expect(h.slept).toHaveLength(2);
  });

  it("maxPolls bounds the loop", async () => {
    const h = harness([{ events: [], view: { status: "RUNNING", nextAction: { kind: "engine", stepKey: null, code: "e", since: "t" } } }]);
    await watchRun("r1", { interval: 1, maxPolls: 3 }, h.deps);
    expect(h.slept).toHaveLength(2);
  });
});

describe("command registration", () => {
  it("registers `import run` with every sub-command, and the destructive ones require --confirm", () => {
    const program = new Command();
    register(program);
    const imps = program.commands.filter((c) => c.name() === "import");
    expect(imps).toHaveLength(1);
    const runs = imps[0].commands.filter((c) => c.name() === "run");
    expect(runs).toHaveLength(1);
    const names = runs[0].commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(["list", "create", "status", "events", "watch", "start", "approve", "retry", "skip", "evidence", "attach", "command", "inputs", "pause", "resume", "abort", "cleanup", "reverse", "decommission", "source-session", "report"]));
    for (const n of ["abort", "cleanup", "reverse", "decommission"]) {
      const c = runs[0].commands.find((x) => x.name() === n)!;
      expect(c.options.find((o) => o.long === "--confirm")?.required).toBe(true);
    }
    expect(runs[0].commands.find((c) => c.name() === "approve")!.options.find((o) => o.long === "--hash")?.required).toBe(true);
  });
});
