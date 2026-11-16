import { H, makeRig, type Rig } from "./testing/cutover-rig";
import { DECOMMISSION_ATTEST, DECOMMISSION_FIRST_ATTEST } from "./decommission.handler";
import { CONTROL_PLANE_REMOVAL_COMMANDS, CONTROL_PLANE_STOP_COMMANDS, MANAGED_REMOVAL_COMMANDS, MANAGED_STOP_COMMANDS, REMOVAL_COMMANDS, STOP_COMMANDS } from "./decommission-script";

afterEach(() => jest.useRealTimers());

const input = <T>(value: T) => ({ value, source: "request" as const, setBy: "user1", at: "2026-11-20T09:00:00Z" });
const HOURS = 3_600_000;

interface DecOpts {
  controller?: "manual" | "api" | "agent";
  topology?: "two-box" | "swap-proxy";
  ageHours?: number;
  dbs?: Array<[string, boolean]>;
  minAge?: number;
}

/** A takeover run whose FINALIZE passed `ageHours` ago. */
function afterFinalize(o: DecOpts = {}): Rig {
  const rig = makeRig({
    apps: [{ id: "a1", host: H(1), hasData: true }],
    options: { decommissionMinAgeHours: o.minAge ?? 72 },
    run: { mode: "takeover", topology: o.topology ?? "swap-proxy", inputs: o.controller ? { sourceController: input(o.controller) } : {}, createdAt: new Date(new Date("2026-11-20T10:00:00Z").getTime() - (o.ageHours ?? 100) * HOURS) },
  });
  rig.driver.setStep("FINALIZE", { status: "PASSED" });
  for (const [id, ok] of o.dbs ?? []) {
    rig.world.databaseIds.push(id);
    rig.world.backups.set(id, ok);
  }
  rig.host.sourceContainers = [
    { id: "aaaaaaaaaaaa", name: "app-uuid-1", running: true },
    { id: "bbbbbbbbbbbb", name: "db-uuid-2", running: true },
    { id: "cccccccccccc", name: "old-one", running: false },
  ];
  return rig;
}

const approveCurrent = async (rig: Rig) => {
  const w = await rig.driver.tick(rig.handlers.dec);
  expect(w.status).toBe("WAITING_APPROVAL");
  rig.driver.approve("DECOMMISSION", (w.wait as unknown as { binding: { inputHash: string } }).binding.inputHash);
};
const scripts = (rig: Rig) => {
  const seen: string[] = [];
  const orig = rig.host.exec.bind(rig.host);
  jest.spyOn(rig.host, "exec").mockImplementation((s: string) => {
    seen.push(s);
    return orig(s);
  });
  return seen;
};

describe("DECOMMISSION preconditions", () => {
  it("exists only for a takeover run", () => {
    const rig = makeRig();
    expect(rig.handlers.dec.applicable({ ...rig.driver.run, mode: "copy" })).toBe(false);
    expect(rig.handlers.dec.applicable({ ...rig.driver.run, mode: "takeover" })).toBe(true);
  });

  it("needs FINALIZE to have passed", async () => {
    const rig = afterFinalize();
    rig.driver.setStep("FINALIZE", { status: "RUNNING" });
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.id === "decommission.finalized")).toMatchObject({ status: "fail" });
  });

  it("a run younger than the minimum age waits on a TIMER until it is old enough", async () => {
    const rig = afterFinalize({ ageHours: 10 });
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.status).toBe("WAITING_TIMER");
    expect(r.wait).toMatchObject({ kind: "timer", code: "decommission.too-young" });
    expect(new Date((r.wait as { notBefore: string }).notBefore).getTime()).toBe(rig.driver.run.createdAt.getTime() + 72 * HOURS);
  });

  it("every migrated database needs at least one successful Tugra backup", async () => {
    const rig = afterFinalize({ dbs: [["db1", true], ["db2", false]] });
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.filter((c) => c.id === "decommission.backup").map((c) => [c.subject, c.status])).toEqual([["db1", "pass"], ["db2", "fail"]]);
    rig.world.backups.set("db2", true);
    expect((await rig.driver.tick(rig.handlers.dec)).status).toBe("WAITING_APPROVAL");
  });

  it("needs the source host (the name the human types)", async () => {
    const rig = afterFinalize();
    rig.driver.run.sourceHost = null;
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.gate!.checks.find((c) => c.id === "decommission.source-host")).toMatchObject({ status: "fail" });
  });

  it("is never advanced into without the typed approval, and the approval is bound to what the human reviewed", async () => {
    const rig = afterFinalize({ controller: "agent" });
    const w = await rig.driver.tick(rig.handlers.dec);
    expect(w.status).toBe("WAITING_APPROVAL");
    const binding = (w.wait as unknown as { binding: { confirm: string; ponr: boolean; review: { containers: string[]; stopOnly: boolean } } }).binding;
    expect(binding).toMatchObject({ confirm: "source-host", ponr: false, review: { stopOnly: true, containers: ["app-uuid-1", "db-uuid-2", "old-one"] } });
    expect(rig.host.log.every((l) => l.kind === "decommission-discover")).toBe(true);
    rig.driver.approve("DECOMMISSION", "0".repeat(64));
    expect((await rig.driver.tick(rig.handlers.dec)).status).toBe("WAITING_APPROVAL");
  });

  it("a container that appears after the approval voids it", async () => {
    const rig = afterFinalize({ controller: "agent" });
    await approveCurrent(rig);
    rig.host.sourceContainers.push({ id: "dddddddddddd", name: "late-one", running: true });
    expect((await rig.driver.tick(rig.handlers.dec)).status).toBe("WAITING_APPROVAL");
    expect(rig.host.log.some((l) => l.kind === "decommission-stop")).toBe(false);
  });
});

describe("DECOMMISSION with the hub's own shell (swap-proxy + agent controller)", () => {
  it("stops the exact running ids it discovered, verifies, prints the removal commands, and never removes anything", async () => {
    const rig = afterFinalize({ controller: "agent" });
    const seen = scripts(rig);
    await approveCurrent(rig);
    const r = await rig.driver.drive(rig.handlers.dec);
    expect(r.status).toBe("PASSED");
    expect(rig.host.sourceContainers.map((c) => c.running)).toEqual([false, false, false]);
    const stop = seen.find((s) => s.includes("TUGRA_SRC_STATE_END"))!;
    expect(stop).toContain("'aaaaaaaaaaaa'");
    expect(stop).toContain("'bbbbbbbbbbbb'");
    expect(stop).not.toContain("cccccccccccc"); // already stopped: not touched
    expect(seen.join("\n")).not.toMatch(/docker rm|volume rm|system prune|docker kill/);
    expect(rig.driver.rec("DECOMMISSION").compensation).toEqual({ stoppedIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"] });
    const ev = rig.driver.events.find((e) => e.code === "decommission.removal-commands")!;
    expect(ev.params).toMatchObject({ keepsVolumes: true });
    expect((ev.params!.commands as string[])[0]).toBe("docker rm 'app-uuid-1' 'db-uuid-2' 'old-one'");
    expect(ev.params!.commands).toEqual(expect.arrayContaining([...REMOVAL_COMMANDS]));
  });

  it("a container that refuses to stop fails the step with its name", async () => {
    const rig = afterFinalize({ controller: "agent" });
    const orig = rig.host.exec.bind(rig.host);
    jest.spyOn(rig.host, "exec").mockImplementation((s: string) => {
      const out = orig(s);
      if (s.includes("TUGRA_SRC_STATE_END")) rig.host.sourceContainers[1].running = true;
      return s.includes("TUGRA_SRC_STATE_END") ? { exitCode: 0, output: out.output.replace("id=bbbbbbbbbbbb running=false", "id=bbbbbbbbbbbb running=true") } : out;
    });
    await approveCurrent(rig);
    const r = await rig.driver.drive(rig.handlers.dec);
    expect(r.fail).toMatchObject({ code: "decommission.still-running", retryable: true, params: { containers: ["db-uuid-2"] } });
  });

  it("an unreadable discovery is `unknown` and blocks (nothing is stopped blind)", async () => {
    const rig = afterFinalize({ controller: "agent" });
    jest.spyOn(rig.host, "exec").mockReturnValue({ exitCode: 0, output: "TUGRA_SRC id=aaaaaaaaaaaa name=x running=true" });
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.id === "decommission.discover")).toMatchObject({ status: "unknown" });
  });

  it("nothing left running: the step passes and stops nothing", async () => {
    const rig = afterFinalize({ controller: "agent" });
    for (const c of rig.host.sourceContainers) c.running = false;
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.status).toBe("PASSED");
    expect(rig.host.log.some((l) => l.kind === "decommission-stop")).toBe(false);
  });
});

describe("DECOMMISSION without a shell on the source (manual controller, or two-box)", () => {
  it("manual controller: prints the stop and removal commands, waits for the operator's attestation, executes nothing", async () => {
    const rig = afterFinalize({ controller: "manual" });
    const seen = scripts(rig);
    await approveCurrent(rig);
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.wait).toEqual({ kind: "operator", code: "decommission.stop-source", params: { stop: [...STOP_COMMANDS], remove: [...REMOVAL_COMMANDS] }, attest: [DECOMMISSION_ATTEST] });
    expect(seen).toEqual([]);
    rig.driver.attest("DECOMMISSION", DECOMMISSION_ATTEST);
    expect((await rig.driver.tick(rig.handlers.dec, "evidence")).status).toBe("PASSED");
    expect(seen).toEqual([]);
    expect((await rig.driver.postGateOf(rig.handlers.dec)).checks[0].evidence).toBe("operator-attested");
  });

  it("the default controller (owner question 8 unanswered) is manual", async () => {
    const rig = afterFinalize({});
    await approveCurrent(rig);
    expect((await rig.driver.tick(rig.handlers.dec)).wait).toMatchObject({ code: "decommission.stop-source" });
  });

  it("two-box takeover: the hub has no shell on the source box, so even `agent` falls back to the printed commands", async () => {
    const rig = afterFinalize({ controller: "agent", topology: "two-box" });
    await approveCurrent(rig);
    expect((await rig.driver.tick(rig.handlers.dec)).wait).toMatchObject({ code: "decommission.stop-source" });
    expect(rig.host.log).toEqual([]);
  });

  it("without the attestation the post gate is false", async () => {
    const rig = afterFinalize({ controller: "manual" });
    expect((await rig.driver.postGateOf(rig.handlers.dec)).passed).toBe(false);
  });
});

describe("DECOMMISSION never undoes or deletes", () => {
  it("compensate is a no-op for every kind", async () => {
    const rig = afterFinalize({ controller: "agent" });
    for (const how of ["abort", "cleanup", "reverse"] as const) expect((await rig.driver.compensate(rig.handlers.dec, how)).outcome).toBe("nothing-to-do");
    expect(rig.host.log).toEqual([]);
  });

  it("dry run states stop-only and the minimum age, touching nothing", async () => {
    const rig = makeRig({ run: { mode: "takeover", dryRun: true } });
    await rig.driver.tick(rig.handlers.dec);
    expect(rig.driver.rec("DECOMMISSION").progress!.dryRun!.map((i) => i.code)).toEqual(["decommission.dry.stop-only", "decommission.dry.min-age", "decommission.dry.order"]);
    expect(rig.host.log).toEqual([]);
  });
});

describe("DECOMMISSION runbook order: the Coolify host goes last (R67/R70)", () => {
  const SIB = { live: 2, undecommissioned: 0 };

  it("a box that carries the control plane is refused while another run of the same source still lives", async () => {
    const rig = afterFinalize({ controller: "agent" });
    rig.host.cpMarker = true;
    rig.world.siblings = SIB;
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.id === "decommission.control-plane-last")).toMatchObject({ status: "fail", code: "decommission.control-plane-last", params: { runs: 2 } });
    // nothing is stopped, and no approval can be given while it holds
    expect(rig.host.log.every((l) => l.kind === "decommission-discover")).toBe(true);
  });

  it("once no other run lives the same box is allowed, and the check says why", async () => {
    const rig = afterFinalize({ controller: "agent" });
    rig.host.cpMarker = true;
    rig.world.siblings = SIB;
    expect((await rig.driver.tick(rig.handlers.dec)).status).toBe("WAITING_OPERATOR");
    rig.world.siblings = { live: 0, undecommissioned: 0 };
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.status).toBe("WAITING_APPROVAL");
    expect(rig.driver.rec("DECOMMISSION").gate!.checks.find((c) => c.id === "decommission.control-plane-last")).toMatchObject({ status: "pass", code: "decommission.control-plane-last-ok" });
  });

  it("an unreadable list of the other runs is unknown and blocks the control-plane box (never read as none)", async () => {
    const rig = afterFinalize({ controller: "agent" });
    rig.host.cpMarker = true;
    rig.world.siblings = null;
    const r = await rig.driver.tick(rig.handlers.dec);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.gate!.checks.find((c) => c.id === "decommission.control-plane-last")).toMatchObject({ status: "unknown", code: "decommission.siblings-unreadable" });
  });

  it("a box that is NOT the control plane is not held back by other live runs; finished runs that did not stop their hosts block the control-plane box", async () => {
    const other = afterFinalize({ controller: "agent" });
    other.host.cpMarker = false;
    other.world.siblings = SIB;
    const r = await other.driver.tick(other.handlers.dec);
    expect(r.status).toBe("WAITING_APPROVAL");
    expect(other.driver.rec("DECOMMISSION").gate!.checks.some((c) => c.id.startsWith("decommission.control-plane") || c.id === "decommission.hosts-pending")).toBe(false);
    const cp = afterFinalize({ controller: "agent" });
    cp.host.cpMarker = true;
    cp.world.siblings = { live: 0, undecommissioned: 3 };
    const w = await cp.driver.tick(cp.handlers.dec);
    // a finished takeover that has not stopped its own hosts is not done: the Coolify host waits for it
    expect(w.status).toBe("WAITING_OPERATOR");
    expect(cp.driver.rec("DECOMMISSION").gate!.checks.find((c) => c.id === "decommission.control-plane-last")).toMatchObject({ status: "fail", code: "decommission.control-plane-last-hosts", params: { runs: 3 } });
    // where the hub cannot see whether the box is the control plane it is only a warning (the printed list holds the order, below)
    const unseen = afterFinalize({ controller: "agent" });
    unseen.host.cpMarker = null;
    unseen.world.siblings = { live: 0, undecommissioned: 3 };
    await unseen.driver.tick(unseen.handlers.dec);
    expect(unseen.driver.rec("DECOMMISSION").gate!.checks.find((c) => c.id === "decommission.hosts-pending")).toMatchObject({ status: "warn", params: { runs: 3 } });
  });

  it("an older discovery script that says nothing about the control plane is not read as 'not the control plane'", async () => {
    const rig = afterFinalize({ controller: "agent" });
    rig.host.cpMarker = null;
    rig.world.siblings = SIB;
    await rig.driver.tick(rig.handlers.dec);
    // unknown: the order is not enforced by the gate, only by what is printed (below)
    const checks = rig.driver.rec("DECOMMISSION").gate!.checks;
    expect(checks.some((c) => c.id === "decommission.control-plane-last")).toBe(false);
    expect(checks.find((c) => c.id === "decommission.hosts-pending")).toBeUndefined();
  });

  it("with the hub's own shell the printed removal commands leave out the control plane while another run lives", async () => {
    const held = afterFinalize({ controller: "agent" });
    held.world.siblings = SIB;
    await approveCurrent(held);
    expect((await held.driver.drive(held.handlers.dec)).status).toBe("PASSED");
    const cmds = held.driver.events.find((e) => e.code === "decommission.removal-commands")!.params!.commands as string[];
    expect(cmds).toEqual(expect.arrayContaining([...MANAGED_REMOVAL_COMMANDS]));
    for (const c of CONTROL_PLANE_REMOVAL_COMMANDS) expect(cmds).not.toContain(c);
    const free = afterFinalize({ controller: "agent" });
    await approveCurrent(free);
    await free.driver.drive(free.handlers.dec);
    expect(free.driver.events.find((e) => e.code === "decommission.removal-commands")!.params!.commands).toEqual(expect.arrayContaining([...CONTROL_PLANE_REMOVAL_COMMANDS]));
  });

  it("without a shell on the box the plan text prints the control plane's commands only after the other runs are done", async () => {
    const held = afterFinalize({ controller: "manual" });
    held.world.siblings = SIB;
    await approveCurrent(held);
    const r = await held.driver.tick(held.handlers.dec);
    expect(r.wait).toEqual({ kind: "operator", code: "decommission.stop-source-first", params: { stop: [...MANAGED_STOP_COMMANDS], remove: [...MANAGED_REMOVAL_COMMANDS], runs: 2 }, attest: [DECOMMISSION_FIRST_ATTEST] });
    const printed = JSON.stringify(r.wait);
    for (const c of [...CONTROL_PLANE_STOP_COMMANDS, ...CONTROL_PLANE_REMOVAL_COMMANDS]) expect(printed).not.toContain(c);
    // the same for an unreadable sibling list (fail closed)
    const unknown = afterFinalize({ controller: "manual" });
    unknown.world.siblings = null;
    await approveCurrent(unknown);
    const unreadable = (await unknown.driver.tick(unknown.handlers.dec)).wait as unknown as { code: string; params: Record<string, unknown> };
    // its own code, so the sentence never prints a count it does not have
    expect(unreadable.code).toBe("decommission.stop-source-unknown");
    expect(unreadable.params).not.toHaveProperty("runs");
    // and with nothing else alive the full list, control plane last, is printed
    const free = afterFinalize({ controller: "manual" });
    await approveCurrent(free);
    const w = (await free.driver.tick(free.handlers.dec)).wait as unknown as { params: { stop: string[]; remove: string[] } };
    expect(w.params.stop).toEqual([...STOP_COMMANDS]);
    expect(w.params.stop.slice(-CONTROL_PLANE_STOP_COMMANDS.length)).toEqual([...CONTROL_PLANE_STOP_COMMANDS]);
  });

  it("finished takeovers that have not stopped their hosts keep the control plane's commands out of the printed list too", async () => {
    const held = afterFinalize({ controller: "manual" });
    held.world.siblings = { live: 0, undecommissioned: 1 };
    await approveCurrent(held);
    const r = await held.driver.tick(held.handlers.dec);
    expect(r.wait).toMatchObject({ code: "decommission.stop-source-first", params: { runs: 1 } });
    for (const c of CONTROL_PLANE_STOP_COMMANDS) expect(JSON.stringify(r.wait)).not.toContain(c);
  });

  it("the first list's attestation closes the step only while other runs remain; once they are done the control plane's list is asked for", async () => {
    const rig = afterFinalize({ controller: "manual" });
    rig.world.siblings = SIB;
    await approveCurrent(rig);
    expect((await rig.driver.tick(rig.handlers.dec)).wait).toMatchObject({ attest: [DECOMMISSION_FIRST_ATTEST] });
    rig.driver.attest("DECOMMISSION", DECOMMISSION_FIRST_ATTEST);
    // the others are still open: the first list was all this run owed
    expect((await rig.driver.drive(rig.handlers.dec)).status).toBe("PASSED");

    const last = afterFinalize({ controller: "manual" });
    last.world.siblings = SIB;
    await approveCurrent(last);
    await last.driver.tick(last.handlers.dec);
    last.driver.attest("DECOMMISSION", DECOMMISSION_FIRST_ATTEST);
    // ...but the other runs finished before this run saw the attestation: it was the last one and has not stopped the control plane
    last.world.siblings = { live: 0, undecommissioned: 0 };
    const r = await last.driver.tick(last.handlers.dec);
    expect(r.status).toBe("WAITING_OPERATOR");
    expect(r.wait).toMatchObject({ code: "decommission.stop-source", attest: [DECOMMISSION_ATTEST] });
    expect(((r.wait as unknown as { params: { stop: string[] } }).params.stop)).toEqual(expect.arrayContaining([...CONTROL_PLANE_STOP_COMMANDS]));
    last.driver.attest("DECOMMISSION", DECOMMISSION_ATTEST);
    expect((await last.driver.drive(last.handlers.dec)).status).toBe("PASSED");
  });

  it("the approval shows whether the box carries the control plane and how many other runs live", async () => {
    const rig = afterFinalize({ controller: "agent" });
    rig.host.cpMarker = true;
    const w = await rig.driver.tick(rig.handlers.dec);
    expect(w.status).toBe("WAITING_APPROVAL");
    expect((w.wait as unknown as { binding: { review: Record<string, unknown> } }).binding.review).toMatchObject({ controlPlane: true, otherLiveRuns: 0 });
  });
});
