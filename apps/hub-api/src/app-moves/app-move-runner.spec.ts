import { APP_ID, FakeWorld, MOVE_ID, type CommandRecord, type Row, type WorldOptions } from "./testing/fake-world";

const SRC_VOL = `tugra_appv_${APP_ID}_data`;

async function go(w: FakeWorld): Promise<void> {
  await w.build().run(MOVE_ID);
  await new Promise((r) => setImmediate(r)); // let fire-and-forget tails (drain, inline archive purge) settle
  await new Promise((r) => setImmediate(r));
}

/** The three invariants the spec asserts at every point of every run. */
function guard(w: FakeWorld): { violations: string[]; serverIds: Set<string> } {
  const out = { violations: [] as string[], serverIds: new Set<string>() };
  const prev = w.beforeCommand;
  w.beforeCommand = async (rec: CommandRecord) => {
    out.serverIds.add(String(w.app.serverId));
    // source volumes are never removed before COMPLETED (a volume rm aimed at the source host)
    if (rec.server === "s1" && /docker volume rm/.test(rec.script) && w.move.phase !== "COMPLETED") out.violations.push(`source volume removed during ${w.move.phase}: ${rec.kind}`);
    // serverId may only be the source until the cutover, then the target; never a third value
    if (!["s1", "s2"].includes(String(w.app.serverId))) out.violations.push(`app on unknown server ${w.app.serverId}`);
    // before the cutover tx commits the app is still on the source
    if (["QUEUED", "PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"].includes(String(w.move.phase)) && w.app.serverId !== "s1") out.violations.push(`app moved early during ${w.move.phase}`);
    await prev?.(rec);
  };
  return out;
}

const runnableOnExactlyOneServer = (w: FakeWorld): boolean => {
  const hosts = Object.entries(w.running).filter(([, r]) => r).map(([h]) => h);
  return hosts.length <= 1 && (hosts.length === 0 || hosts[0] === w.app.serverId);
};

const kinds = (w: FakeWorld): string[] => w.kinds();

describe("AppMoveRunnerService — forward path", () => {
  it("classic RUNNING app: QUEUED -> PRECHECK -> STOPPING_SOURCE -> TRANSFERRING -> DEPLOYING -> FINALIZING -> COMPLETED, in the documented order", async () => {
    const w = new FakeWorld();
    const g = guard(w);
    await go(w);
    expect(w.phases).toEqual(["PRECHECK", "STOPPING_SOURCE", "TRANSFERRING", "DEPLOYING", "FINALIZING", "COMPLETED"]);
    expect(w.move.phase).toBe("COMPLETED");
    // command order: prepare on the target; stop + verify on the source; pack/stat/(relay)/drop per part; apply on the target; deploy; cleanup
    const order = kinds(w);
    expect(order.slice(0, 4)).toEqual(["prepare@s2", "stop@s1", "verify@s1", "pack@s1"]);
    expect(order.filter((k) => k === "stat@s1")).toHaveLength(3);
    expect(order.filter((k) => k === "drop@s1")).toHaveLength(3);
    expect(w.transferCalls).toBe(3);
    expect(order.indexOf("apply@s2")).toBeGreaterThan(order.lastIndexOf("drop@s1"));
    expect(order.indexOf("remove@s1")).toBeGreaterThan(order.indexOf("apply@s2"));
    expect(order.slice(-2).sort()).toEqual(["cleanup@s1", "cleanup@s2"]);
    expect(g.violations).toEqual([]);
    expect([...g.serverIds]).toEqual(["s1", "s2"]); // the server id flipped exactly once
  });

  it("the app ends on the target with the SAME id, running there, the source container removed but its volumes kept", async () => {
    const w = new FakeWorld();
    await go(w);
    expect(w.app.id).toBe(APP_ID);
    expect(w.app.serverId).toBe("s2");
    expect(w.app.status).toBe("RUNNING");
    expect(runnableOnExactlyOneServer(w)).toBe(true);
    expect(w.running).toEqual({ s1: false, s2: true });
    expect(w.onHost("remove").map((c) => c.server)).toEqual(["s1"]);
    // no volume rm anywhere on the source (the archive stays until archiveUntil)
    expect(w.commands.filter((c) => c.server === "s1" && /docker volume rm/.test(c.script))).toEqual([]);
    expect(runnableOnExactlyOneServer(w)).toBe(true);
  });

  it("records the transfer state per volume (PENDING -> PACKED -> TRANSFERRED -> APPLIED) with part/byte progress", async () => {
    const w = new FakeWorld();
    await go(w);
    const v = w.move.volumes[0];
    expect(v).toMatchObject({ state: "APPLIED", parts: 3, partsDone: 3, bytesDone: 3072, entries: 5, createdOnTarget: true, archiveOverwritten: false });
  });

  it("the move deploy is keyed move:<id> with the move's requester; the deployment id is stored", async () => {
    const w = new FakeWorld();
    await go(w);
    expect(w.deployments).toHaveLength(1);
    expect(w.deployments[0]).toMatchObject({ idempotencyKey: `move:${MOVE_ID}`, requestedBy: "u1" });
    expect(w.move.deploymentId).toBe(w.deployments[0].id);
  });

  it("cutover stamps legacy deployments/backups with the SOURCE, moves ONLY the app's log drains, and stores a secret-free snapshot", async () => {
    const w = new FakeWorld();
    w.deployments.push({ id: "old", appId: APP_ID, status: "SUCCESS", runServerId: null, idempotencyKey: null });
    await go(w);
    expect(w.deployments.find((d) => d.id === "old")!.runServerId).toBe("s1");
    expect(w.deployments.find((d) => d.idempotencyKey === `move:${MOVE_ID}`)!.runServerId ?? null).toBeNull(); // new deploys keep NULL = "current"
    // LOCAL (no destination / a LOCAL destination) are stamped, S3 is not
    expect(Object.fromEntries(w.volumeBackups.map((b) => [b.id, b.hostServerId]))).toEqual({ "vb-local": "s1", "vb-s3": null, "vb-localdest": "s1" });
    expect(Object.fromEntries(w.logDrains.map((d) => [d.id, d.serverId]))).toEqual({ ld1: "s2", "ld-server-wide": "s1" });
    expect(w.move.snapshotBefore).toEqual({ serverId: "s1", logDrains: [{ id: "ld1", serverId: "s1" }], domains: [] });
    expect(JSON.stringify(w.move.snapshotBefore)).not.toMatch(/env|cert|token|secret/i);
  });

  it("finalize: archive clock starts (retainDays), the completed notification carries names + date, audit trail, queue drained", async () => {
    const w = new FakeWorld({ retainDays: 3 });
    await go(w);
    expect(w.move.finishedAt).toBeInstanceOf(Date);
    expect(w.move.archiveUntil.getTime() - w.move.finishedAt.getTime()).toBeGreaterThan(3 * 86_400_000 - 5000);
    expect(w.move.archiveUntil.getTime() - w.move.finishedAt.getTime()).toBeLessThan(3 * 86_400_000 + 5000);
    expect(w.move.sourcePurgedAt).toBeNull();
    expect(w.move.ownerId).toBeNull();
    expect(w.events).toEqual([{ teamId: "t1", type: "app_move_completed", ctx: expect.objectContaining({ appId: APP_ID, appName: "blog", sourceName: "alpha", targetName: "beta", archiveUntil: expect.any(String) }) }]);
    expect(w.audits.map((a) => a.action)).toEqual(["app.move.cutover", "app.move.complete"]);
    expect(w.drains).toEqual([APP_ID]);
    expect(JSON.stringify(w.events)).not.toMatch(/agent-vx|sig=/);
  });

  it("a volume that is absent on the source / external is never packed (SKIPPED) and a move with NO data volume has no archive", async () => {
    const w = new FakeWorld({ volumes: [{ name: "x", dockerName: "tugra_appv_x", kind: "app", sizeBytes: null, state: "SKIPPED", parts: 0, partsDone: 0, bytesDone: 0, entries: null, createdOnTarget: false, archiveOverwritten: false }] });
    await go(w);
    expect(w.onHost("pack")).toEqual([]);
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.move.archiveUntil).toBeNull();
    expect(w.move.sourcePurgedAt).toBeInstanceOf(Date); // nothing to archive: nothing to purge
    expect(w.events[0].ctx.archiveUntil).toBe("");
  });

  it("compose volumes are prepared with the labels compose expects (no 'not created for project' warning)", async () => {
    const dockerName = `tugra_${APP_ID}_dbdata`;
    const w = new FakeWorld({ app: { source: "COMPOSE" }, volumes: [{ name: "dbdata", dockerName, kind: "compose", sizeBytes: 100, state: "PENDING", parts: 0, partsDone: 0, bytesDone: 0, entries: null, createdOnTarget: false, archiveOverwritten: false }] });
    await go(w);
    const prep = w.onHost("prepare")[0].script;
    expect(prep).toContain(`--label com.docker.compose.project=tugra_${APP_ID}`);
    expect(prep).toContain("--label com.docker.compose.volume=dbdata");
    expect(w.move.phase).toBe("COMPLETED");
  });

  it("an archive-overwriting volume (it already existed on the target) is flagged and not marked createdOnTarget", async () => {
    const w = new FakeWorld();
    w.volumesOnHost.s2.add(SRC_VOL); // an earlier move left an archive here
    await go(w);
    expect(w.move.volumes[0]).toMatchObject({ createdOnTarget: false, archiveOverwritten: true, state: "APPLIED" });
  });
});

describe("AppMoveRunnerService — STOPPED / FAILED / NEW origins", () => {
  it("STOPPED origin: no stop before the copy needed, deployed on the target, then STOPPED again there", async () => {
    const w = new FakeWorld({ status: "STOPPED" });
    await go(w);
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.onHost("stop").map((c) => c.server)).toEqual(["s2"]); // the post-deploy stop, only on the target
    expect(w.app.status).toBe("STOPPED");
    expect(w.app.serverId).toBe("s2");
    expect(w.running).toEqual({ s1: false, s2: false });
  });

  it("a STOPPED origin whose source is NOT actually quiescent is stopped first, then verified", async () => {
    const w = new FakeWorld({ status: "STOPPED" });
    w.running.s1 = true; // the row says STOPPED but a container still runs
    await go(w);
    expect(kinds(w).slice(0, 5)).toEqual(["prepare@s2", "verify@s1", "stop@s1", "verify@s1", "pack@s1"]);
    expect(w.move.phase).toBe("COMPLETED");
  });

  it("FAILED origin + a failing target deploy: NO rollback — stays on the target as FAILED with a warning", async () => {
    const w = new FakeWorld({ status: "FAILED" });
    w.deployOutcomes.move = "FAILED";
    await go(w);
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.app.serverId).toBe("s2");
    expect(w.app.status).toBe("FAILED");
    expect(w.move.warnings).toEqual(expect.arrayContaining([{ code: "deploy_failed_after_move" }]));
    expect(w.phases).not.toContain("ROLLING_BACK");
  });

  it("a STOPPED origin whose target deploy fails IS rolled back (it must be able to run somewhere)", async () => {
    const w = new FakeWorld({ status: "STOPPED" });
    w.deployOutcomes.move = "FAILED";
    await go(w);
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.app.serverId).toBe("s1");
    expect(w.app.status).toBe("STOPPED");
  });

  it("a STOPPED target stop that fails is only a warning (target_stop_failed)", async () => {
    const w = new FakeWorld({ status: "STOPPED" });
    w.handlers.stop = [(_n, server) => (server === "s2" ? { exitCode: 1, output: "boom" } : undefined)];
    await go(w);
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.move.warnings).toEqual(expect.arrayContaining([{ code: "target_stop_failed" }]));
  });

  it("NEW app (cheap path): config flip only — no agent command at all, no deploy, COMPLETED in the cutover tx with nothing to archive", async () => {
    const w = new FakeWorld({ status: "NEW" });
    guard(w);
    await go(w);
    expect(w.commands).toEqual([]);
    expect(w.deployments).toEqual([]);
    expect(w.phases).toEqual(["PRECHECK", "COMPLETED"]);
    expect(w.app).toMatchObject({ serverId: "s2", status: "NEW" });
    expect(w.move).toMatchObject({ phase: "COMPLETED", archiveUntil: null, ownerId: null });
    expect(w.move.sourcePurgedAt).toBeInstanceOf(Date);
    expect(w.events.map((e) => e.type)).toEqual(["app_move_completed"]);
  });
});

describe("AppMoveRunnerService — cutover field rules", () => {
  it("magic domain follows the target (acknowledged); the pre-image records the old one", async () => {
    const w = new FakeWorld({
      app: { domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" },
      acks: { domainChanges: true },
      plan: { domain: { kind: "magic", from: "blog-ab12cd.1-2-3-4.sslip.io", to: "blog-ab12cd.5-6-7-8.sslip.io" } },
    });
    await go(w);
    expect(w.app.domain).toBe("blog-ab12cd.5-6-7-8.sslip.io");
    expect(w.move.snapshotBefore).toMatchObject({ serverId: "s1", domain: "blog-ab12cd.1-2-3-4.sslip.io" });
  });

  it("a busy host port is reallocated through the allocator INSIDE the transaction (acknowledged)", async () => {
    const w = new FakeWorld({ app: { hostPort: 8080 }, acks: { hostPortChanged: true }, plan: { hostPort: { from: 8080, to: 20001 } } });
    w.otherApps.push({ id: "other", serverId: "s2", hostPort: 8080, portMappings: null, extraPorts: null });
    await go(w);
    expect(w.app.hostPort).toBe(20001);
    expect(w.portAlloc.allocate).toHaveBeenCalledWith("s2", 1, expect.anything(), expect.any(Set));
    expect(w.move.snapshotBefore).toMatchObject({ hostPort: 8080 });
  });

  it("the reallocated port is chosen against the target's extraPorts AND the moving app's own baked ports, not only live listeners", async () => {
    const w = new FakeWorld({ app: { hostPort: 8080, extraPorts: [{ hostPort: 20002, containerPort: 1 }], portMappings: [{ hostPort: 20003 }] }, acks: { hostPortChanged: true }, plan: { hostPort: { from: 8080, to: 20001 } } });
    w.otherApps.push({ id: "other", serverId: "s2", hostPort: 8080, portMappings: null, extraPorts: [{ hostPort: 20001 }] });
    (w.portAlloc.allocate as jest.Mock).mockResolvedValueOnce([20004]); // what a correct allocator returns given the set it was handed
    await go(w);
    const taken = (w.portAlloc.allocate as jest.Mock).mock.calls[0][3] as Set<number>;
    expect([...taken].sort((a, b) => a - b)).toEqual([8080, 20001, 20002, 20003]);
    expect(w.app.hostPort).toBe(20004);
    expect(w.move.phase).toBe("COMPLETED");
  });

  it("a reallocated port that collides with a baked port aborts the cutover (the defensive check), source untouched", async () => {
    const w = new FakeWorld({ app: { hostPort: 8080, extraPorts: [{ hostPort: 20001 }] }, acks: { hostPortChanged: true }, plan: { hostPort: { from: 8080, to: 20001 } } });
    w.otherApps.push({ id: "other", serverId: "s2", hostPort: 8080, portMappings: null, extraPorts: null });
    await go(w); // the (fake) allocator ignores `probed` and hands out 20001, which the app itself bakes in
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "cutover_failed" });
    expect(w.app).toMatchObject({ serverId: "s1", hostPort: 8080 });
  });

  it("a free host port is kept (the allocator is not consulted)", async () => {
    const w = new FakeWorld({ app: { hostPort: 8080 }, plan: { hostPort: { from: 8080, to: 8080 } } });
    await go(w);
    expect(w.app.hostPort).toBe(8080);
    expect(w.portAlloc.allocate).not.toHaveBeenCalled();
  });

  it("dropped host-bound settings (acknowledged) are cleared and remembered", async () => {
    const w = new FakeWorld({
      app: { cpusetCpus: "0-15", gpus: "all", allowPrivilegedDockerOptions: true, dockerOptions: "--privileged" },
      acks: { resetCpuset: true, dropGpus: true, dropPrivilegedOptions: true },
    });
    w.servers.s2.cpuCores = 4;
    await go(w);
    expect(w.app).toMatchObject({ cpusetCpus: null, gpus: null, allowPrivilegedDockerOptions: false, dockerOptions: null });
    expect(w.move.snapshotBefore).toMatchObject({ cpusetCpus: "0-15", gpus: "all", allowPrivilegedDockerOptions: true, dockerOptions: "--privileged" });
  });

  it("a template compose gets its self-urls rebased to the target", async () => {
    const composeFile = "services:\n  a:\n    environment:\n      URL: http://blog-ab12cd.1-2-3-4.sslip.io\n";
    const w = new FakeWorld({
      app: { source: "COMPOSE", templateSlug: "wp", composeFile, domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" },
      acks: { domainChanges: true },
      plan: { domain: { kind: "magic", from: "blog-ab12cd.1-2-3-4.sslip.io", to: "blog-ab12cd.5-6-7-8.sslip.io" } },
      volumes: [],
    });
    await go(w);
    expect(w.app.composeFile).toContain("blog-ab12cd.5-6-7-8.sslip.io");
    expect(w.move.snapshotBefore.composeFile).toBe(composeFile);
  });

  it("an acknowledgement that went missing by cutover time (the situation changed) rolls back instead of silently continuing", async () => {
    const w = new FakeWorld({ app: { hostPort: 8080 }, acks: {}, plan: { hostPort: { from: 8080, to: 8080 } } });
    w.otherApps.push({ id: "other", serverId: "s2", hostPort: 8080, portMappings: null, extraPorts: null });
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "changed_under_us" });
    expect(w.app).toMatchObject({ serverId: "s1", hostPort: 8080 });
  });
});

// ───────────────────────────── failure injection ─────────────────────────────

const fail = (exitCode: number, output = "boom\n") => ({ exitCode, output });
const only = (server: string, r: { exitCode: number; output: string }) => (_n: number, s: string) => (s === server ? r : undefined);
const badTransfer = { ok: false, sendExit: 22, recvExit: 0, detail: "source exit 22: curl: (22) 502" };

function expectRolledBack(w: FakeWorld, reason: string, phase: string, opts: { restarted?: boolean } = {}): void {
  expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: reason, failurePhase: phase, ownerId: null });
  expect(w.move.finishedAt).toBeTruthy();
  // the app is back where it was, in the state it was
  expect(w.app.serverId).toBe("s1");
  expect(w.app.status).toBe("RUNNING");
  if (opts.restarted !== false) expect(w.running).toEqual({ s1: true, s2: false });
  // the source's DATA was never touched (the volume exists untouched; no volume rm aimed at the source)
  expect(w.commands.filter((c) => c.server === "s1" && /docker volume rm/.test(c.script))).toEqual([]);
  expect(w.events.map((e) => e.type)).toEqual(["app_move_rolled_back"]);
  expect(w.events[0].ctx.reason).toBe(reason);
  expect(w.audits.map((a) => a.action)).toContain("app.move.rollback");
  expect(w.drains).toEqual([APP_ID]);
}

describe("AppMoveRunnerService — every failure before the cutover rolls back with the source intact", () => {
  const cases: [string, (w: FakeWorld) => void, string, string, { restarted?: boolean }?][] = [
    ["stop command fails", (w) => (w.handlers.stop = [only("s1", fail(1))]), "stop_failed", "STOPPING_SOURCE"],
    ["the app is still running after the stop (unverified)", (w) => (w.handlers.verify = [() => fail(1, "TUGRA_VX_RUNNING\n")]), "stop_unverified", "STOPPING_SOURCE"],
    ["prepare fails", (w) => (w.handlers.prepare = [() => fail(1)]), "prepare_failed", "PRECHECK", { restarted: true }],
    ["prepare output is unparseable", (w) => (w.handlers.prepare = [() => ({ exitCode: 0, output: "garbage" })]), "prepare_failed", "PRECHECK"],
    ["pack fails", (w) => (w.handlers.pack = [() => fail(1)]), "pack_failed", "TRANSFERRING"],
    ["pack output is unparseable", (w) => (w.handlers.pack = [() => ({ exitCode: 0, output: "TUGRA_VX_PACKED parts=0 entries=1" })]), "pack_failed", "TRANSFERRING"],
    ["a part cannot be measured", (w) => (w.handlers.stat = [() => ({ exitCode: 0, output: "nope" })]), "part_stat_failed", "TRANSFERRING"],
    ["a part fails 3 times in a row", (w) => (w.transferResults = [badTransfer, badTransfer, badTransfer]), "transfer_failed", "TRANSFERRING"],
    ["the target reports a sha mismatch", (w) => (w.transferResults = Array(3).fill({ ...badTransfer, recvExit: 66 })), "sha_mismatch", "TRANSFERRING"],
    ["the target reports a size mismatch", (w) => (w.transferResults = Array(3).fill({ ...badTransfer, recvExit: 65 })), "size_mismatch", "TRANSFERRING"],
    ["apply aborts before the wipe (72)", (w) => (w.handlers.apply = [() => fail(72)]), "apply_aborted", "TRANSFERRING"],
    ["apply fails and rolls back (71)", (w) => (w.handlers.apply = [() => fail(71)]), "apply_rolled_back", "TRANSFERRING"],
    ["apply AND its rollback fail (70)", (w) => (w.handlers.apply = [() => fail(70)]), "apply_rollback_failed", "TRANSFERRING"],
    ["the extracted entry count differs (68)", (w) => (w.handlers.apply = [() => fail(68)]), "entry_count_mismatch", "TRANSFERRING"],
    ["apply reports a different count than the pack", (w) => (w.handlers.apply = [() => ({ exitCode: 0, output: "TUGRA_VX_APPLY_OK entries=4\n" })]), "entry_count_mismatch", "TRANSFERRING"],
    ["apply fails with an unknown code", (w) => (w.handlers.apply = [() => fail(5)]), "apply_failed", "TRANSFERRING"],
    ["a new blocker appears at PRECHECK", (w) => (w.preflight = () => ({ ...w.okPreflight(), ok: false, blockers: [{ code: "db_links_exist" }] })), "preflight_changed", "PRECHECK"],
    ["the planned volume set changed", (w) => (w.preflight = () => ({ ...w.okPreflight(), plan: { ...w.okPreflight().plan, volumes: [] } })), "preflight_changed", "PRECHECK"],
    ["the derived domain changed", (w) => (w.preflight = () => ({ ...w.okPreflight(), plan: { ...w.okPreflight().plan, domain: { kind: "magic", from: "a", to: "b" } } })), "preflight_changed", "PRECHECK"],
    ["the app was moved/edited under us (CAS lost)", (w) => (w.beforeCommand = (rec) => void (rec.kind === "apply" && (w.app.serverId = "sX"))), "changed_under_us", "TRANSFERRING", { restarted: false }],
  ];

  // (rest params: jest-each would mistake a 5th declared parameter for a `done` callback on rows that omit it)
  it.each(cases)("%s", async (...row) => {
    const [, arrange, reason, phase, opts] = row;
    const w = new FakeWorld();
    const g = guard(w);
    arrange(w);
    // a guard replaced by arrange() (CAS case) must still be restored for the invariant check below
    if (reason !== "changed_under_us") expect(w.beforeCommand).toBeDefined();
    await go(w);
    if (reason === "changed_under_us") {
      expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: reason, failurePhase: "TRANSFERRING" });
      expect(w.app.serverId).toBe("sX"); // we never touched an app someone else moved
      return;
    }
    expectRolledBack(w, reason, phase, opts);
    expect(g.violations).toEqual([]);
    expect(runnableOnExactlyOneServer(w)).toBe(true);
    // never a cutover: the move deploy was not enqueued, the stamps were not written
    expect(w.deployments).toEqual([]);
    expect(w.volumeBackups.every((b) => b.hostServerId === null)).toBe(true);
    expect(w.move.snapshotBefore).toBeNull();
    expect(w.move.cutoverAt).toBeNull();
  });

  it("rollback cleans the TARGET: staging + the volumes THIS move created + the apply snapshot, label-checked in-script; source staging too", async () => {
    const w = new FakeWorld();
    w.handlers.apply = [() => fail(71)];
    await go(w);
    const cleanups = w.onHost("cleanup");
    expect(cleanups.map((c) => c.server).sort()).toEqual(["s1", "s2"]);
    const target = cleanups.find((c) => c.server === "s2")!.script;
    expect(target).toContain(`docker volume rm '${SRC_VOL}'`);
    expect(target).toContain(`tugra_restore_rb_${MOVE_ID}_0`);
    expect(target).toContain(`[ "$lb" = '${MOVE_ID}' ]`);
    expect(cleanups.find((c) => c.server === "s1")!.script).not.toContain("docker volume rm"); // the source only loses its staging dir
    expect(w.move.targetPurgedAt).toBeTruthy();
  });

  it("an archive-overwritten volume is NEVER removed by the rollback (only its rollback snapshot is)", async () => {
    const w = new FakeWorld();
    w.volumesOnHost.s2.add(SRC_VOL);
    w.handlers.apply = [() => fail(71)];
    await go(w);
    const target = w.onHost("cleanup").find((c) => c.server === "s2")!.script;
    expect(target).not.toContain(`docker volume rm '${SRC_VOL}'`);
    expect(target).toContain(`tugra_restore_rb_${MOVE_ID}_0`);
  });

  it("apply exit 70 (extract AND rollback failed): the rollback snapshot is the only intact copy, so the rollback keeps it, flags it and warns", async () => {
    const w = new FakeWorld();
    w.handlers.apply = [() => fail(70, "RECOVERY_REQUIRED rollback=tugra_restore_rb_x\n")];
    await go(w);
    const target = w.onHost("cleanup").find((c) => c.server === "s2")!.script;
    expect(target).toContain(`docker volume rm '${SRC_VOL}'`); // the volume this move created still goes
    expect(target).not.toContain(`tugra_restore_rb_${MOVE_ID}_0`); // the snapshot does not
    expect(w.move.volumes[0]).toMatchObject({ rollbackKept: true });
    expect(w.move.warnings).toEqual([{ code: "apply_snapshot_kept", details: { volume: "data", snapshot: `tugra_restore_rb_${MOVE_ID}_0` } }]);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "apply_rollback_failed", targetPurgedAt: expect.any(Date) });
  });

  it("an apply with an UNKNOWN outcome (timeout / lost agent) keeps the snapshot of an overwritten archive, not that of a fresh volume", async () => {
    const overwritten = new FakeWorld();
    overwritten.volumesOnHost.s2.add(SRC_VOL);
    overwritten.handlers.apply = [() => { throw new Error("command timed out"); }];
    await go(overwritten);
    expect(overwritten.move.volumes[0]).toMatchObject({ archiveOverwritten: true, rollbackKept: true });
    expect(overwritten.onHost("cleanup").find((c) => c.server === "s2")!.script).not.toContain(`tugra_restore_rb_${MOVE_ID}_0`);

    const fresh = new FakeWorld();
    fresh.handlers.apply = [() => { throw new Error("command timed out"); }];
    await go(fresh);
    expect(fresh.move.volumes[0].rollbackKept).toBeUndefined();
    expect(fresh.onHost("cleanup").find((c) => c.server === "s2")!.script).toContain(`tugra_restore_rb_${MOVE_ID}_0`);
  });

  it("a prepare that fails after creating some volumes: the rollback removes them by label (createdOnTarget was never recorded)", async () => {
    const w = new FakeWorld();
    w.handlers.prepare = [() => fail(1, `TUGRA_VX_CREATED ${SRC_VOL} 1\ndocker: no space left\n`)];
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "prepare_failed" });
    expect(w.move.volumes[0].createdOnTarget).toBe(false);
    const target = w.onHost("cleanup").find((c) => c.server === "s2")!.script;
    expect(target).toContain(`docker volume rm '${SRC_VOL}'`);
    expect(target).toContain(`[ "$lb" = '${MOVE_ID}' ]`);
    expect(w.move.targetPurgedAt).toBeTruthy();
  });

  it("an offline target during rollback: cleanup is skipped and left for the sweeper (targetPurgedAt stays NULL) — the app is still restored", async () => {
    const w = new FakeWorld();
    w.handlers.apply = [() => { w.online.s2 = false; return fail(71); }];
    await go(w);
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.move.targetPurgedAt).toBeNull();
    expect(w.onHost("cleanup").map((c) => c.server)).toEqual(["s1"]);
    expect(w.app.status).toBe("RUNNING");
  });

  it("a target that goes offline mid-copy is reported as agent_offline", async () => {
    const w = new FakeWorld();
    w.handlers.pack = [() => { w.online.s2 = false; return undefined; }];
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "agent_offline" });
  });

  it("a failure BEFORE the stop never touches the running app (no stop, no restart)", async () => {
    const w = new FakeWorld();
    w.handlers.prepare = [() => fail(1)];
    await go(w);
    expect(w.onHost("stop")).toEqual([]);
    expect(w.onHost("start")).toEqual([]);
    expect(w.running.s1).toBe(true);
  });

  it("a failed stop restarts the source (a partial stop may have happened)", async () => {
    const w = new FakeWorld();
    w.handlers.stop = [only("s1", fail(1))];
    await go(w);
    expect(w.onHost("start").map((c) => c.server)).toEqual(["s1"]);
  });
});

describe("AppMoveRunnerService — user deploys during PRECHECK", () => {
  it("a RUNNING user deploy is waited out (bounded) and the move then proceeds; QUEUED ones were never a blocker", async () => {
    const w = new FakeWorld();
    const dep = { id: "u1", appId: APP_ID, status: "RUNNING", idempotencyKey: null };
    w.deployments.push(dep, { id: "u2", appId: APP_ID, status: "QUEUED", idempotencyKey: null });
    setTimeout(() => void (dep.status = "SUCCESS"), 15);
    await go(w);
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.move.logTail).toContain("waiting for a running deployment");
  });

  it("one that never ends fails the PRECHECK at the wait's bound with a clear reason, before anything on the source is touched", async () => {
    const w = new FakeWorld();
    w.deployments.push({ id: "u1", appId: APP_ID, status: "RUNNING", idempotencyKey: null });
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "preflight_changed", failurePhase: "PRECHECK" });
    expect(w.onHost("stop")).toEqual([]);
  });
});

describe("AppMoveRunnerService — retries, backoff, cancel, deadline", () => {
  it("a part that fails twice and then succeeds is retried (3 attempts) without failing the move", async () => {
    const w = new FakeWorld();
    w.transferResults = [badTransfer, badTransfer];
    await go(w);
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.transferCalls).toBe(2 + 3); // 2 failed attempts + 3 parts
    expect(w.move.logTail).toContain("part 0 of volume 0 failed (attempt 1)");
  });

  it("a busy relay seat waits with backoff and does NOT consume attempts", async () => {
    const w = new FakeWorld();
    w.transferResults = Array(8).fill({ ok: false, busy: true, sendExit: null, recvExit: null, detail: "relay busy" });
    await go(w);
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.transferCalls).toBe(8 + 3);
  });

  it.each(["prepare", "stop", "pack", "stat", "apply"])("cancel injected during %s: rolls back with reason `cancelled`, app restored", async (kind) => {
    const w = new FakeWorld();
    const g = guard(w);
    const base = w.beforeCommand;
    w.beforeCommand = async (rec) => {
      await base?.(rec);
      if (rec.kind === kind) {
        w.move.cancelRequested = true;
        w.runner.requestCancel(MOVE_ID);
      }
    };
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "cancelled" });
    expect(w.app).toMatchObject({ serverId: "s1", status: "RUNNING" });
    expect(g.violations).toEqual([]);
    expect(w.deployments).toEqual([]);
  });

  it("cancel racing the cutover: the cutover transaction's compare-and-set loses -> nothing moved, rolled back", async () => {
    const w = new FakeWorld({ app: { hostPort: 8080 }, plan: { hostPort: { from: 8080, to: 8080 } } });
    w.portAlloc.probeUsedPorts = async () => {
      w.move.cancelRequested = true; // lands between the last checkpoint and the transaction
      return new Set<number>();
    };
    // keep the checkpoint before the cutover quiet: the flag is set only AFTER it ran
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "cancelled" });
    expect(w.app.serverId).toBe("s1");
    expect(w.logDrains.find((d) => d.id === "ld1")!.serverId).toBe("s1");
    expect(w.volumeBackups.every((b) => b.hostServerId === null)).toBe(true);
  });

  it("the deadline passing mid-transfer rolls back with deadline_exceeded", async () => {
    const w = new FakeWorld();
    w.handlers.stat = [() => { w.move.deadlineAt = new Date(Date.now() - 1000); return undefined; }];
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "deadline_exceeded" });
  });

  it("heartbeat + ownership: the row is owned by this boot while it runs, heartbeats, and is released at the end", async () => {
    const w = new FakeWorld();
    let owner: unknown;
    w.handlers.pack = [() => { owner = w.move.ownerId; return undefined; }];
    const base = w.beforeCommand;
    w.beforeCommand = async (rec) => {
      await base?.(rec);
      if (rec.kind === "pack") await new Promise((r) => setTimeout(r, 25)); // long enough for several 5 ms heartbeats
    };
    await go(w);
    expect(owner).toBe("boot-1");
    expect(w.move.heartbeatAt).toBeTruthy();
    expect(w.move.ownerId).toBeNull();
  });

  it("a second run() of the same move is a no-op while one is active, and run() of a terminal move does nothing", async () => {
    const w = new FakeWorld();
    const r = w.build();
    await Promise.all([r.run(MOVE_ID), r.run(MOVE_ID)]);
    expect(w.onHost("prepare")).toHaveLength(1);
    const before = w.commands.length;
    await r.run(MOVE_ID); // already COMPLETED
    expect(w.commands.length).toBe(before);
  });
});

// ───────────────────────────── after the cutover ─────────────────────────────

describe("AppMoveRunnerService — failure after the cutover rolls back from the snapshot", () => {
  const rich = (): WorldOptions => ({
    app: { hostPort: 8080, domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" },
    acks: { hostPortChanged: true, domainChanges: true },
    plan: { hostPort: { from: 8080, to: 20001 }, domain: { kind: "magic", from: "blog-ab12cd.1-2-3-4.sslip.io", to: "blog-ab12cd.5-6-7-8.sslip.io" } },
  });
  const worldWithBusyPort = (o: WorldOptions): FakeWorld => {
    const w = new FakeWorld(o);
    w.otherApps.push({ id: "other", serverId: "s2", hostPort: 8080, portMappings: null, extraPorts: null });
    return w;
  };

  it("target deploy FAILED (RUNNING origin): serverId, domain, hostPort and log drains are restored; the target container removed; the source restarted", async () => {
    const w = worldWithBusyPort(rich());
    const g = guard(w);
    w.deployOutcomes.move = "FAILED";
    await go(w);
    expect(w.phases).toEqual(["PRECHECK", "STOPPING_SOURCE", "TRANSFERRING", "DEPLOYING", "ROLLING_BACK", "ROLLED_BACK"]);
    expectRolledBack(w, "deploy_failed", "DEPLOYING");
    expect(w.app).toMatchObject({ serverId: "s1", hostPort: 8080, domain: "blog-ab12cd.1-2-3-4.sslip.io", domainKind: "magic" });
    expect(w.logDrains.find((d) => d.id === "ld1")!.serverId).toBe("s1");
    expect(w.onHost("remove").map((c) => c.server)).toEqual(["s2"]); // the target's container; its volumes go through the label-checked cleanup
    expect(g.violations).toEqual([]);
    // the stamps are CORRECT (they say where that data physically lives) and are not reversed
    expect(w.volumeBackups.find((b) => b.id === "vb-local")!.hostServerId).toBe("s1");
  });

  it("the cutover pre-image round-trips: after a rollback the app row equals what it was before the move", async () => {
    const w = worldWithBusyPort(rich());
    const before = { ...w.app };
    w.deployOutcomes.move = "FAILED";
    await go(w);
    for (const k of ["serverId", "hostPort", "domain", "domainKind", "composeFile", "cpusetCpus", "gpus", "dockerOptions", "allowPrivilegedDockerOptions"]) expect(w.app[k]).toEqual(before[k]);
  });

  it("the move's queued deploy is cancelled so it can never run on the wrong server; waiting deploys resume afterwards", async () => {
    const w = new FakeWorld();
    w.deployOutcomes.move = "HANG";
    const orig = w.apps.submitMoveDeploy;
    w.apps.submitMoveDeploy = async (...a: unknown[]) => {
      const r = await orig(...a);
      w.move.deadlineAt = new Date(Date.now() - 1); // the wait for the deploy times out
      return r;
    };
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "deploy_timeout", failurePhase: "DEPLOYING" });
    expect(w.deployments[0].status).toBe("CANCELLED");
    expect(w.app.serverId).toBe("s1");
    expect(w.drains).toEqual([APP_ID]);
  });

  it("when `docker start` on the source fails (container gone) a normal deploy `move:<id>:rb` brings the app back", async () => {
    const w = new FakeWorld();
    w.deployOutcomes.move = "FAILED";
    w.handlers.start = [only("s1", fail(1, "No such container"))];
    await go(w);
    expect(w.move.phase).toBe("ROLLED_BACK");
    const rb = w.deployments.find((d) => d.idempotencyKey === `move:${MOVE_ID}:rb`)!;
    expect(rb).toBeDefined();
    expect(rb.status).toBe("SUCCESS");
    expect(w.app).toMatchObject({ serverId: "s1", status: "RUNNING" });
  });

  it("source restart impossible (start fails AND the rollback deploy fails): FAILED + app FAILED + a CRITICAL notification; the source data is untouched", async () => {
    const w = new FakeWorld();
    w.deployOutcomes.move = "FAILED";
    w.deployOutcomes.rb = "FAILED";
    w.handlers.start = [only("s1", fail(1))];
    await go(w);
    expect(w.move).toMatchObject({ phase: "FAILED", failureReason: "deploy_failed", ownerId: null });
    expect(w.app.status).toBe("FAILED");
    expect(w.events.map((e) => e.type)).toEqual(["app_move_failed"]);
    expect(w.audits.map((a) => a.action)).toContain("app.move.fail");
    expect(w.commands.filter((c) => c.server === "s1" && /docker volume rm/.test(c.script))).toEqual([]);
  });

  it("FAILED because the source could not be restarted: needs attention (neither purge stamp set, even though the target cleanup succeeded) and a critical notification", async () => {
    const w = new FakeWorld();
    w.deployOutcomes.move = "FAILED";
    w.deployOutcomes.rb = "FAILED";
    w.handlers.start = [only("s1", fail(1))];
    await go(w);
    expect(w.onHost("cleanup").some((c) => c.server === "s2")).toBe(true); // the target WAS cleaned...
    expect(w.move).toMatchObject({ phase: "FAILED", sourcePurgedAt: null, targetPurgedAt: null }); // ...but that must not read as "handled"
    // the predicate every consumer (view, preflight blocker, banner) keys on
    expect(w.move.phase === "FAILED" && !w.move.sourcePurgedAt && !w.move.targetPurgedAt).toBe(true);
    expect(w.events.map((e) => e.type)).toEqual(["app_move_failed"]);
  });

  it("the rollback fallback deploy gets its OWN time budget: a rollback for deploy_timeout (move deadline already spent) still waits for it and succeeds", async () => {
    const w = new FakeWorld();
    w.deployOutcomes.move = "HANG";
    w.deployDelayMs = 25;
    w.handlers.start = [only("s1", fail(1, "No such container"))];
    const orig = w.apps.submitMoveDeploy;
    w.apps.submitMoveDeploy = async (...a: unknown[]) => {
      const r = await orig(...a);
      w.move.deadlineAt = new Date(Date.now() - 1); // spent for good: every poll of the forward wait says TIMEOUT
      return r;
    };
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "deploy_timeout" });
    expect(w.deployments.find((d) => d.idempotencyKey === `move:${MOVE_ID}:rb`)!.status).toBe("SUCCESS");
    expect(w.app).toMatchObject({ serverId: "s1", status: "RUNNING" });
  });

  it("...and that wait is bounded: an rb deploy that never ends fails the rollback at its own budget (FAILED, needs attention)", async () => {
    const w = new FakeWorld();
    w.deployOutcomes.move = "HANG";
    w.deployOutcomes.rb = "HANG";
    w.handlers.start = [only("s1", fail(1, "No such container"))];
    const orig = w.apps.submitMoveDeploy;
    w.apps.submitMoveDeploy = async (...a: unknown[]) => {
      const r = await orig(...a);
      w.move.deadlineAt = new Date(Date.now() - 1);
      return r;
    };
    await go(w);
    expect(w.move).toMatchObject({ phase: "FAILED", sourcePurgedAt: null, targetPurgedAt: null });
    expect(w.app.status).toBe("FAILED");
  });

  it("a rollback that finds the app on NEITHER server refuses to guess: FAILED (needs a human)", async () => {
    const w = new FakeWorld();
    w.deployOutcomes.move = "FAILED";
    const base = w.beforeCommand;
    w.beforeCommand = async (rec) => {
      await base?.(rec);
      if (rec.kind === "remove" && rec.phase === "ROLLING_BACK") w.app.serverId = "s9";
    };
    // make the restore step see the foreign value: flip it as soon as the rollback starts
    const orig = w.apps.cancelMoveDeployment;
    w.apps.cancelMoveDeployment = async (...a: unknown[]) => {
      w.app.serverId = "s9";
      return orig(...a);
    };
    w.deployments.push({ id: "stuck", appId: APP_ID, status: "QUEUED", idempotencyKey: `move:${MOVE_ID}` });
    await go(w);
    expect(w.move.phase).toBe("FAILED");
    expect(w.app.serverId).toBe("s9"); // untouched
  });

  it("source offline when the rollback needs to restart it: the move stays ROLLING_BACK (released for recovery); the next run finishes it exactly once", async () => {
    const w = new FakeWorld();
    w.deployOutcomes.move = "FAILED";
    const r = w.build();
    w.online.s1 = true;
    // the source drops off right after the target container is removed
    w.handlers.remove = [(n, server) => { if (server === "s2" && n === 1) w.online.s1 = false; return undefined; }];
    await r.run(MOVE_ID);
    expect(w.move.phase).toBe("ROLLING_BACK");
    expect(w.move.ownerId).toBeNull();
    expect(w.events).toEqual([]);
    // later: the agent is back; recovery (a fresh run) completes the rollback — idempotently
    w.online.s1 = true;
    const restores = JSON.stringify(w.move.snapshotBefore);
    await r.run(MOVE_ID);
    await new Promise((x) => setImmediate(x));
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.events.map((e) => e.type)).toEqual(["app_move_rolled_back"]);
    expect(w.app).toMatchObject({ serverId: "s1", status: "RUNNING" });
    expect(w.running).toEqual({ s1: true, s2: false });
    expect(JSON.stringify(w.move.snapshotBefore)).toBe(restores);
  });
});

describe("AppMoveRunnerService — finalize is best-effort per step", () => {
  it("DNS repoint, source cleanup and staging cleanup failures become warnings; the move still COMPLETES", async () => {
    const w = new FakeWorld({ repointDns: true });
    w.domains.push({ id: "d1", applicationId: APP_ID, hostname: "blog.example.com", mode: "auto", dnsCredentialId: "c1", recordIds: [{ type: "A", name: "blog.example.com", recordId: "r1", created: true }] });
    w.dns.previewRecords = jest.fn().mockRejectedValue(new Error("cloudflare 500"));
    w.handlers.remove = [only("s1", fail(1))];
    w.handlers.cleanup = [() => fail(1)];
    await go(w);
    expect(w.move.phase).toBe("COMPLETED");
    const codes = (w.move.warnings as { code: string }[]).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["dns_repoint_failed", "source_cleanup_failed", "staging_cleanup_failed"]));
    expect(w.events.map((e) => e.type)).toEqual(["app_move_completed"]);
  });

  it("unmanaged domains are reported with the NEW address for a manual DNS change; with repointDns off nothing is touched", async () => {
    const on = new FakeWorld({ repointDns: true });
    on.domains.push({ id: "d1", applicationId: APP_ID, hostname: "manual.example.com", mode: "manual", dnsCredentialId: null, recordIds: null });
    await go(on);
    expect(on.move.warnings).toEqual(expect.arrayContaining([{ code: "dns_manual_repoint", details: { ip: "5.6.7.8", hostnames: ["manual.example.com"] } }]));
    const off = new FakeWorld({ repointDns: false });
    off.domains.push({ id: "d1", applicationId: APP_ID, hostname: "x.example.com", mode: "auto", dnsCredentialId: "c", recordIds: [{ type: "A", name: "x", recordId: "r" }] });
    await go(off);
    expect(off.dns.previewRecords).not.toHaveBeenCalled();
  });

  it("repointDns with a Tugra-written record repoints it through the DNS service (overwrite limited to recorded ids)", async () => {
    const w = new FakeWorld({ repointDns: true });
    w.domains.push({ id: "d1", applicationId: APP_ID, hostname: "blog.example.com", mode: "auto", dnsCredentialId: "c1", recordIds: [{ type: "A", name: "blog.example.com", recordId: "r1", created: true }] });
    w.dns.previewRecords = jest.fn().mockResolvedValue({ records: [{ type: "A", name: "blog.example.com", content: "5.6.7.8", proxied: false, action: "conflict", existingId: "r1" }] });
    await go(w);
    expect(w.dns.applyRecords).toHaveBeenCalledWith("u1", APP_ID, { domain: "blog.example.com", credentialId: "c1", includeWww: false, overwrite: true });
    expect(w.move.phase).toBe("COMPLETED");
  });

  it("retainDays 0: the archive is purged right away (source volumes removed ONLY after COMPLETED) and sourcePurgedAt stamped", async () => {
    const w = new FakeWorld({ retainDays: 0 });
    await go(w);
    const purge = w.onHost("archive-purge");
    expect(purge).toHaveLength(1);
    expect(purge[0]).toMatchObject({ server: "s1", phase: "COMPLETED" });
    expect(purge[0].script).toContain(`docker volume rm '${SRC_VOL}'`);
    expect(w.move.sourcePurgedAt).toBeTruthy();
  });

  it("post-cutover sync failures are recorded as a warning, not a failure", async () => {
    const w = new FakeWorld();
    w.apps.syncAfterMove = async () => ["tunnel"];
    await go(w);
    expect(w.move.phase).toBe("COMPLETED");
    expect(w.move.warnings).toEqual(expect.arrayContaining([{ code: "post_cutover_sync_failed", details: { steps: ["tunnel"] } }]));
  });

  it("warnings are recorded once", async () => {
    const w = new FakeWorld();
    w.apps.syncAfterMove = async () => ["tunnel"];
    await go(w);
    expect((w.move.warnings as { code: string }[]).filter((x) => x.code === "post_cutover_sync_failed")).toHaveLength(1);
  });
});

describe("AppMoveRunnerService — the log tail", () => {
  it("is scrubbed (no relay paths) and capped at 16 KiB", async () => {
    const w = new FakeWorld();
    w.transferResults = [{ ok: false, sendExit: 22, recvExit: 0, detail: `curl: (22) https://hub.example.com/api/v1/agent-vx/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB ${"x".repeat(20_000)}` }];
    await go(w);
    expect(w.move.logTail).not.toMatch(/agent-vx|sig=/);
    expect(w.move.logTail.length).toBeLessThanOrEqual(16 * 1024);
  });
});

describe("AppMoveRunnerService — unexpected errors", () => {
  it("an unexpected exception inside a step is an internal_error rollback (never an unhandled crash)", async () => {
    const w = new FakeWorld();
    w.preflights.computePreflight = jest.fn().mockRejectedValue(new Error("db exploded at /etc/tugra/secret"));
    await go(w);
    expect(w.move).toMatchObject({ phase: "ROLLED_BACK", failureReason: "internal_error", failurePhase: "PRECHECK" });
    expect(w.app).toMatchObject({ serverId: "s1", status: "RUNNING" });
  });

  it("an exception OUTSIDE the abort paths (the final write of the rollback fails) releases the move for recovery instead of leaving it owned by a dead run", async () => {
    const w = new FakeWorld();
    w.handlers.apply = [() => fail(71)];
    const update = w.prisma.appMove.update;
    let blew = false;
    w.prisma.appMove.update = async (a: { where: { id: string }; data: Record<string, unknown> }) => {
      if (a.data.phase === "ROLLED_BACK" && !blew) {
        blew = true;
        throw new Error("connection reset");
      }
      return update(a);
    };
    await go(w);
    expect(blew).toBe(true);
    expect(w.move.phase).toBe("ROLLING_BACK"); // not terminal: recovery will finish it (every rollback step is idempotent)
    expect(w.move.ownerId).toBeNull();
    expect(w.move.logTail).toContain("internal error");
    // and recovery does finish it, exactly once
    await w.build().run(MOVE_ID);
    await new Promise((r) => setImmediate(r));
    expect(w.move.phase).toBe("ROLLED_BACK");
    expect(w.events.map((e) => e.type)).toEqual(["app_move_rolled_back"]);
  });

  it("failNeedsAttention marks FAILED once, never for a terminal move", async () => {
    const w = new FakeWorld();
    w.move.phase = "ROLLING_BACK";
    w.move.failureReason = "hub_restarted";
    const r = w.build();
    await r.failNeedsAttention(MOVE_ID, "deadline_exceeded");
    expect(w.move).toMatchObject({ phase: "FAILED", failureReason: "hub_restarted" }); // the ORIGINAL reason is kept
    expect(w.app.status).toBe("FAILED");
    const events = w.events.length;
    await r.failNeedsAttention(MOVE_ID, "deadline_exceeded");
    expect(w.events).toHaveLength(events);
  });
});
