import { H, makeRig, type Rig } from "./testing/cutover-rig";
import { DECOMMISSION_ATTEST } from "./decommission.handler";
import { REMOVAL_COMMANDS, STOP_COMMANDS } from "./decommission-script";

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
    expect(rig.driver.rec("DECOMMISSION").progress!.dryRun!.map((i) => i.code)).toEqual(["decommission.dry.stop-only", "decommission.dry.min-age"]);
    expect(rig.host.log).toEqual([]);
  });
});
