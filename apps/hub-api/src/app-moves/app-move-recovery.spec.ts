import { AppMoveRecoveryService } from "./app-move-recovery.service";
import { APP_ID, FakeWorld, MOVE_ID, type WorldOptions } from "./testing/fake-world";

const waitDone = async (w: FakeWorld, ms = 3000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!w.runner.isRunning(MOVE_ID) && ["COMPLETED", "ROLLED_BACK", "FAILED"].includes(String(w.move.phase))) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** A fresh process (new bootId) over a world restored from a crash snapshot. */
function reboot(opts: WorldOptions, snap: FakeWorld["crashPoints"][number], extra: (w: FakeWorld) => void = () => undefined): FakeWorld {
  const w = new FakeWorld(opts);
  w.restore(snap.snap);
  w.running = { ...snap.running };
  w.lease.bootId = "boot-2";
  extra(w);
  w.settlePending();
  return w;
}

function recoveryOf(w: FakeWorld): AppMoveRecoveryService {
  w.build();
  return new AppMoveRecoveryService(w.prisma as never, w.agentWs as never, w.lease as never, w.runner);
}

const runnable = (w: FakeWorld): boolean => {
  const hosts = Object.entries(w.running).filter(([, r]) => r).map(([h]) => h);
  return hosts.length <= 1 && (hosts.length === 0 || hosts[0] === w.app.serverId);
};

describe("crash-injection matrix: a hub restart at ANY command boundary ends COMPLETED or ROLLED_BACK, never an app with no runnable server", () => {
  const scenarios: [string, WorldOptions, (w: FakeWorld) => void][] = [
    ["RUNNING classic app, target deploy succeeds", {}, () => undefined],
    ["RUNNING classic app, target deploy fails", {}, (w) => (w.deployOutcomes.move = "FAILED")],
    ["STOPPED app", { status: "STOPPED" }, () => undefined],
    ["RUNNING app with a busy port + magic domain", { app: { hostPort: 8080, domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" }, acks: { hostPortChanged: true, domainChanges: true }, plan: { hostPort: { from: 8080, to: 20001 }, domain: { kind: "magic", from: "blog-ab12cd.1-2-3-4.sslip.io", to: "blog-ab12cd.5-6-7-8.sslip.io" } } }, (w) => w.otherApps.push({ id: "other", serverId: "s2", hostPort: 8080, portMappings: null, extraPorts: null })],
  ];

  it.each(scenarios)("%s", async (...row) => {
    const [, opts, arrange] = row;
    // 1. the original run records the persisted state at every command boundary (= what a crash there leaves behind)
    const first = new FakeWorld(opts);
    arrange(first);
    first.recordCrashPoints = true;
    await first.build().run(MOVE_ID);
    await new Promise((r) => setImmediate(r));
    const expectedTerminal = String(first.move.phase);
    expect(["COMPLETED", "ROLLED_BACK"]).toContain(expectedTerminal);
    expect(first.crashPoints.length).toBeGreaterThan(8);

    // 2. a new process takes over from every one of them
    const seen = new Set<string>();
    for (const cp of first.crashPoints) {
      if (["COMPLETED", "ROLLED_BACK", "FAILED"].includes(String(cp.snap.t.appMove[0].phase))) continue;
      const w = reboot(opts, cp, arrange);
      // the crashed process left the row owned by a dead boot
      expect(w.move.ownerId === null || w.move.ownerId === "boot-1").toBe(true);
      const recovery = recoveryOf(w);
      const driven = await recovery.recover();
      expect(driven).toEqual([MOVE_ID]);
      await waitDone(w);
      const label = `${cp.kind} (phase ${cp.snap.t.appMove[0].phase})`;
      seen.add(String(cp.snap.t.appMove[0].phase));

      // never FAILED here (agents are healthy), always a clean terminal state
      expect(["COMPLETED", "ROLLED_BACK"]).toContain(String(w.move.phase));
      // invariant 1: the app is runnable on exactly one server (or stopped, for a STOPPED/NEW origin)
      expect(runnable(w)).toBe(true);
      if (opts.status !== "STOPPED") expect(Object.values(w.running).filter(Boolean)).toHaveLength(1);
      if (w.move.phase === "COMPLETED") {
        expect(w.app.serverId).toBe("s2");
        if (opts.status !== "STOPPED") expect(w.running).toEqual({ s1: false, s2: true });
      } else {
        expect(w.app.serverId).toBe("s1");
        expect(w.app.status).toBe(opts.status ?? "RUNNING");
        if (opts.status !== "STOPPED") expect(w.running).toEqual({ s1: true, s2: false });
      }
      // invariant 2: source volumes are never removed before COMPLETED (a volume rm on the source only after it)
      for (const c of w.commands.filter((c2) => c2.server === "s1" && /docker volume rm/.test(c2.script))) expect(c.phase).toBe("COMPLETED");
      // invariant 3: the server id only ever moved with the cutover: pre-cutover crash points are rolled back on the source
      if (["PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"].includes(String(cp.snap.t.appMove[0].phase))) {
        expect(w.move.phase).toBe("ROLLED_BACK");
        expect(w.move.failureReason).toBe("hub_restarted");
      }
      // exactly one terminal notification per move, whichever process finished it
      expect(w.events).toHaveLength(1);
      void label;
    }
    // the matrix really covered every non-terminal phase this scenario goes through
    for (const phase of ["PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"]) expect([...seen]).toContain(phase);
    if (expectedTerminal === "COMPLETED") expect([...seen]).toEqual(expect.arrayContaining(["DEPLOYING", "FINALIZING"]));
  });
});

describe("AppMoveRecoveryService.recover — per-phase behaviour", () => {
  async function recoverFrom(w: FakeWorld, phase: string, mutate: (w: FakeWorld) => void = () => undefined): Promise<FakeWorld> {
    w.move.phase = phase;
    w.move.ownerId = "boot-dead";
    mutate(w);
    w.lease.bootId = "boot-2";
    w.settlePending();
    const rec = recoveryOf(w);
    await rec.recover();
    await waitDone(w);
    return w;
  }

  /** The world as it looks right after the cutover committed (app on the target, snapshot stored). */
  function postCutover(w: FakeWorld): void {
    w.app.serverId = "s2";
    w.move.cutoverAt = new Date();
    w.move.snapshotBefore = { serverId: "s1", logDrains: [], domains: [] };
    w.move.volumes[0].state = "APPLIED";
    w.running = { s1: false, s2: false };
  }

  it("QUEUED (never started), PRECHECK, STOPPING_SOURCE, TRANSFERRING: streams are not resumable -> rolled back (QUEUED simply starts)", async () => {
    const queued = await recoverFrom(new FakeWorld(), "QUEUED");
    expect(queued.move.phase).toBe("COMPLETED"); // never ran: it is just driven forward
    for (const phase of ["PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"]) {
      const w = await recoverFrom(new FakeWorld(), phase, (x) => (x.running.s1 = phase === "PRECHECK")); // PRECHECK: not stopped yet
      expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "hub_restarted", failurePhase: phase });
      expect(w.app).toMatchObject({ serverId: "s1", status: "RUNNING" });
      expect(w.running).toEqual({ s1: true, s2: false });
    }
  });

  it("DEPLOYING with NO deployment row: the move deploy is enqueued, awaited, then finalized", async () => {
    const w = await recoverFrom(new FakeWorld(), "DEPLOYING", postCutover);
    expect(w.deployments.map((d) => d.idempotencyKey)).toEqual([`move:${MOVE_ID}`]);
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.app.serverId).toBe("s2");
  });

  it.each(["QUEUED", "RUNNING"])("DEPLOYING with a %s deployment: adopted and awaited (nothing re-enqueued)", async (status) => {
    const w = await recoverFrom(new FakeWorld(), "DEPLOYING", (x) => {
      postCutover(x);
      x.deployments.push({ id: "dep-1", appId: APP_ID, status, idempotencyKey: `move:${MOVE_ID}`, trigger: "move" });
    });
    expect(w.deployments).toHaveLength(1);
    expect(w.move.deploymentId).toBe("dep-1");
    expect(w.move.phase).toBe("COMPLETED");
  });

  it("DEPLOYING with a SUCCESS deployment: straight to FINALIZING -> COMPLETED", async () => {
    const w = await recoverFrom(new FakeWorld(), "DEPLOYING", (x) => {
      postCutover(x);
      x.deployments.push({ id: "dep-1", appId: APP_ID, status: "SUCCESS", idempotencyKey: `move:${MOVE_ID}`, trigger: "move" });
      x.app.status = "RUNNING";
      x.running.s2 = true;
    });
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.deployments).toHaveLength(1);
    expect(w.onHost("remove").map((c) => c.server)).toEqual(["s1"]);
  });

  it.each(["FAILED", "CANCELLED"])("DEPLOYING with a %s deployment: rollback-after-cutover restores the source", async (status) => {
    const w = await recoverFrom(new FakeWorld(), "DEPLOYING", (x) => {
      postCutover(x);
      x.deployments.push({ id: "dep-1", appId: APP_ID, status, idempotencyKey: `move:${MOVE_ID}`, trigger: "move" });
    });
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "deploy_failed", failurePhase: "DEPLOYING" });
    expect(w.app).toMatchObject({ serverId: "s1", status: "RUNNING" });
    expect(w.running).toEqual({ s1: true, s2: false });
  });

  it("FINALIZING: the idempotent steps rerun and the move completes (once)", async () => {
    const w = await recoverFrom(new FakeWorld(), "FINALIZING", (x) => {
      postCutover(x);
      x.app.status = "RUNNING";
      x.running.s2 = true;
      x.deployments.push({ id: "dep-1", appId: APP_ID, status: "SUCCESS", idempotencyKey: `move:${MOVE_ID}` });
    });
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.events.map((e) => e.type)).toEqual(["app_move_completed"]);
  });

  it("ROLLING_BACK continues where it stopped (reason and phase preserved)", async () => {
    const w = await recoverFrom(new FakeWorld(), "ROLLING_BACK", (x) => {
      x.move.failureReason = "sha_mismatch";
      x.move.failurePhase = "TRANSFERRING";
      x.running.s1 = false;
    });
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "sha_mismatch", failurePhase: "TRANSFERRING" });
    expect(w.running).toEqual({ s1: true, s2: false });
  });

  it("terminal moves, moves owned by THIS process and moves already being driven are left alone", async () => {
    const w = new FakeWorld();
    w.move.phase = "COMPLETED";
    w.move.ownerId = "boot-dead";
    w.lease.bootId = "boot-2";
    expect(await recoveryOf(w).recover()).toEqual([]);
    const own = new FakeWorld();
    own.move.phase = "TRANSFERRING";
    own.move.ownerId = "boot-2";
    own.lease.bootId = "boot-2";
    expect(await recoveryOf(own).recover()).toEqual([]);
  });

  it("a released move (ownerId NULL) is picked up", async () => {
    const w = new FakeWorld();
    w.move.phase = "ROLLING_BACK";
    w.move.failureReason = "deadline_exceeded";
    w.move.failurePhase = "TRANSFERRING";
    w.move.ownerId = null;
    w.lease.bootId = "boot-2";
    w.running.s1 = false;
    const rec = recoveryOf(w);
    expect(await rec.recover()).toEqual([MOVE_ID]);
    await waitDone(w);
    expect(w.move.phase).toBe("ROLLED_BACK");
  });
});

describe("AppMoveRecoveryService — agents offline", () => {
  it("while the agent a rollback needs is offline the move stays ROLLING_BACK; when it is back the next pass finishes it", async () => {
    const w = new FakeWorld();
    w.move.phase = "ROLLING_BACK";
    w.move.failureReason = "hub_restarted";
    w.move.failurePhase = "TRANSFERRING";
    w.move.ownerId = "boot-dead";
    w.move.deadlineAt = new Date(Date.now() + 3600_000);
    w.lease.bootId = "boot-2";
    w.running.s1 = false;
    w.online.s1 = false;
    const rec = recoveryOf(w);
    await rec.recover();
    await waitDone(w, 200);
    expect(w.move.phase).toBe("ROLLING_BACK");
    expect(w.move.ownerId).toBeNull();
    expect(w.events).toEqual([]);
    w.online.s1 = true;
    expect(await rec.recover()).toEqual([MOVE_ID]);
    await waitDone(w);
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.running).toEqual({ s1: true, s2: false });
  });

  it("past the deadline with the needed agent STILL offline: FAILED (needs attention), app marked failed, critical notification", async () => {
    const w = new FakeWorld();
    w.move.phase = "ROLLING_BACK";
    w.move.failureReason = "hub_restarted";
    w.move.failurePhase = "TRANSFERRING";
    w.move.ownerId = "boot-dead";
    w.move.deadlineAt = new Date(Date.now() - 1000);
    w.lease.bootId = "boot-2";
    w.online.s1 = false;
    const rec = recoveryOf(w);
    expect(await rec.recover()).toEqual([]); // not driven: given up
    await new Promise((r) => setImmediate(r));
    expect(w.move).toMatchObject({ phase: "FAILED", failureReason: "hub_restarted" });
    expect(w.app.status).toBe("FAILED");
    expect(w.events.map((e) => e.type)).toEqual(["app_move_failed"]);
  });

  it("past the deadline but the agent is back: it is still driven (the deadline only gives up on an unreachable server)", async () => {
    const w = new FakeWorld();
    w.move.phase = "ROLLING_BACK";
    w.move.failureReason = "hub_restarted";
    w.move.failurePhase = "TRANSFERRING";
    w.move.ownerId = "boot-dead";
    w.move.deadlineAt = new Date(Date.now() - 1000);
    w.lease.bootId = "boot-2";
    w.running.s1 = false;
    expect(await recoveryOf(w).recover()).toEqual([MOVE_ID]);
    await waitDone(w);
    expect(w.move.phase).toBe("ROLLED_BACK");
  });

  it("DEPLOYING needs the TARGET's agent: offline past the deadline gives up; FINALIZING never gives up (it is best-effort)", async () => {
    const w = new FakeWorld();
    w.move.phase = "DEPLOYING";
    w.move.ownerId = "boot-dead";
    w.move.deadlineAt = new Date(Date.now() - 1000);
    w.lease.bootId = "boot-2";
    w.online.s2 = false;
    expect(await recoveryOf(w).recover()).toEqual([]);
    expect(w.move.phase).toBe("FAILED");
    const f = new FakeWorld();
    f.move.phase = "FINALIZING";
    f.move.ownerId = "boot-dead";
    f.move.deadlineAt = new Date(Date.now() - 1000);
    f.lease.bootId = "boot-2";
    f.online = { s1: false, s2: false };
    expect(await recoveryOf(f).recover()).toEqual([MOVE_ID]);
  });
});
