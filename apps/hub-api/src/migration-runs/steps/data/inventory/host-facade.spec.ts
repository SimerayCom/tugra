import { MigrationRunsService } from "../../../core/migration-runs.service";
import type { ActResult } from "../../../core/run-contract";
import { RunWorld, ACTOR } from "../../../core/testing/run-world";
import { HostCommandError, type HostCommandInput, type RunHostCommandPort } from "./inventory-contract";
import { FakeHostReports } from "./testing/fake-host-reports";

const TOKEN = `tugra_mig_${"C".repeat(43)}`;
const HUB = "https://hub.example.test";
const PLACEHOLDER = `tugra_mig_${"x".repeat(43)}`;

class FakeCommands implements RunHostCommandPort {
  inputs: HostCommandInput[] = [];
  failWith: HostCommandError | null = null;
  async build(input: HostCommandInput) {
    this.inputs.push(input);
    if (this.failWith) throw this.failWith;
    return { command: `SCRIPT(${input.kind},${input.step})`, hosts: ["srv-a"] };
  }
}

/** A world whose DATA_FINAL / FREEZE wait for an operator command, with the host-loop builder and report store wired in. */
function setup(opts: { sourceRunner: "operator" | "coolify-host-loop"; waitStep?: "DATA_FINAL" | "FREEZE" | "DATA_SEED"; commandKind?: "inventory" | "host-loop"; attest?: string[]; compensate?: boolean }) {
  const act = async (): Promise<ActResult> => ({
    outcome: "wait",
    wait: { kind: "operator", code: "data.run-migrator", offersCommand: true, attest: opts.attest ?? ["freeze-containers-unresolved"], ...(opts.commandKind ? { commandKind: opts.commandKind } : {}) },
  });
  const w = new RunWorld({ stubs: { [opts.waitStep ?? "DATA_FINAL"]: { act, ...(opts.compensate ? { compensate: async () => ({ outcome: "manual" as const, manual: [{ code: "freeze.host-loop-unfreeze", params: { hosts: ["srv-a"], count: 1 } }] }) } : {}) } } });
  const cmds = new FakeCommands();
  const reports = new FakeHostReports();
  w.service = new MigrationRunsService(w.store, w.engine, w.registry, w.env, w.sink, w.port, cmds, reports);
  w.port.mintCommand = async (_u: string, opId: string, _b: string, o: { reissue: boolean; certs: boolean }) => {
    w.port.calls.push(`mint:${opId}:${o.reissue ? "reissue" : "mint"}`);
    return { expiresAt: new Date(w.clock.t + 3_600_000), command: `curl -fsSL ${HUB}/install/migrator.sh | TUGRA_MIGRATION_TOKEN=${TOKEN} sh -s -- --hub ${HUB}` };
  };
  const body = w.createBody();
  const create = () => w.create({ options: { ...body.options, sourceRunner: opts.sourceRunner } as never });
  return { w, cmds, reports, create };
}

describe("run facade: the host-loop and inventory commands", () => {
  it("a coolify-host-loop run mints the host-loop script by default, through the live token, and nothing but the response carries it", async () => {
    const { w, cmds, create } = setup({ sourceRunner: "coolify-host-loop" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    const res = await w.service.command(ACTOR, id, "DATA_FINAL", { reissue: false }, HUB);
    expect(res).toMatchObject({ stepKey: "DATA_FINAL", kind: "host-loop", command: "SCRIPT(host-loop,DATA_FINAL)", shownOnce: true });
    expect(res.commands).toBeUndefined();
    // dry-built with a placeholder first (a doomed request must not rotate the token), then built with the real token, once
    expect(cmds.inputs.map((i) => i.token)).toEqual([PLACEHOLDER, TOKEN]);
    expect(w.port.calls.filter((c) => c.startsWith("mint:"))).toEqual(["mint:op-1:mint"]);
    expect(JSON.stringify([await w.view(id), w.store.eventRows, w.sink.audits])).not.toContain(TOKEN);
    expect(w.sink.audits.find((a) => a.action === "migration.run.command")?.meta).toMatchObject({ step: "DATA_FINAL", kind: "host-loop" });
  });

  it("the inventory kind can be asked for explicitly; a host-loop run asked for the classic migrator command still gets it", async () => {
    const { w, cmds, create } = setup({ sourceRunner: "coolify-host-loop" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    const inv = await w.service.command(ACTOR, id, "DATA_FINAL", { reissue: false, kind: "inventory" }, HUB);
    expect(inv).toMatchObject({ kind: "inventory", command: "SCRIPT(inventory,DATA_FINAL)" });
    expect(cmds.inputs.at(-1)).toMatchObject({ kind: "inventory", token: TOKEN });
    const classic = await w.service.command(ACTOR, id, "DATA_FINAL", { reissue: true, kind: "migrator" }, HUB);
    expect(classic).toMatchObject({ kind: "migrator" });
    expect(classic.command).toContain("TUGRA_MIGRATION_TOKEN=");
  });

  it("the host-loop kind exists only for the coolify-host-loop runner", async () => {
    const { w, create } = setup({ sourceRunner: "operator" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    await expect(w.service.command(ACTOR, id, "DATA_FINAL", { reissue: false, kind: "host-loop" }, HUB)).rejects.toThrow(/command-kind-unavailable/);
    expect(w.port.calls.filter((c) => c.startsWith("mint:"))).toEqual([]); // nothing was minted for a refused request
    // the classic migrator command of an operator run is untouched
    expect(await w.service.command(ACTOR, id, "DATA_FINAL", { reissue: false }, HUB)).toMatchObject({ kind: "migrator" });
  });

  it("a request the builder refuses (no hosts) answers 409 and does NOT mint, so a command already pasted keeps working", async () => {
    const { w, cmds, create } = setup({ sourceRunner: "coolify-host-loop" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    cmds.failWith = new HostCommandError("no-hosts");
    await expect(w.service.command(ACTOR, id, "DATA_FINAL", { reissue: false }, HUB)).rejects.toThrow(/host-loop-no-hosts/);
    cmds.failWith = new HostCommandError("unsafe-input");
    await expect(w.service.command(ACTOR, id, "DATA_FINAL", { reissue: false }, HUB)).rejects.toThrow(/host-loop-unsafe-input/);
    expect(w.port.calls.filter((c) => c.startsWith("mint:"))).toEqual([]);
  });

  it("FREEZE mints the host-loop script (and only that kind) and tells the builder which checks the operator attested", async () => {
    const { w, cmds, create } = setup({ sourceRunner: "coolify-host-loop", waitStep: "FREEZE" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    expect(w.stepStatus(id, "FREEZE")).toBe("WAITING_OPERATOR");
    await expect(w.service.command(ACTOR, id, "FREEZE", { reissue: false, kind: "migrator" }, HUB)).rejects.toThrow(/step-has-no-command/);
    await w.service.evidence(ACTOR, id, "FREEZE", { checkId: "freeze-containers-unresolved", note: "looked at the host" });
    const res = await w.service.command(ACTOR, id, "FREEZE", { reissue: false }, HUB);
    expect(res).toMatchObject({ stepKey: "FREEZE", kind: "host-loop" });
    expect(cmds.inputs.at(-1)).toMatchObject({ step: "FREEZE", kind: "host-loop", token: TOKEN, attested: ["freeze-containers-unresolved"] });
  });

  it("FREEZE has no command at all for a run that is not a host-loop run", async () => {
    const { w, create } = setup({ sourceRunner: "operator", waitStep: "FREEZE" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    await expect(w.service.command(ACTOR, id, "FREEZE", { reissue: false }, HUB)).rejects.toThrow(/command-kind-unavailable/);
    expect(w.port.calls.filter((c) => c.startsWith("mint:"))).toEqual([]);
  });

  it("attach: a host-inventory must be a stored INVENTORY report of this run", async () => {
    const { w, reports, create } = setup({ sourceRunner: "coolify-host-loop" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    const inv = await reports.put({ runId: id, stepKey: "", sourceServerRef: "srv-a", kind: "inventory", state: "complete", payload: {} });
    const loop = await reports.put({ runId: id, stepKey: "DATA_SEED", sourceServerRef: "srv-a", kind: "loop", state: "finished", payload: {} });
    const other = await reports.put({ runId: "someone-elses-run", stepKey: "", sourceServerRef: "srv-a", kind: "inventory", state: "complete", payload: {} });
    const v = await w.service.attach(ACTOR, id, "DATA_FINAL", { kind: "host-inventory", resourceId: inv.id });
    expect(v.steps.find((s) => s.key === "DATA_FINAL")!.evidence.attachments).toEqual([expect.objectContaining({ kind: "host-inventory", resourceId: inv.id })]);
    await expect(w.service.attach(ACTOR, id, "DATA_FINAL", { kind: "host-inventory", resourceId: loop.id })).rejects.toThrow(/resource-not-found/);
    await expect(w.service.attach(ACTOR, id, "DATA_FINAL", { kind: "host-inventory", resourceId: other.id })).rejects.toThrow(/resource-not-found/);
    await expect(w.service.attach(ACTOR, id, "DATA_FINAL", { kind: "host-inventory", resourceId: "nope" })).rejects.toThrow(/resource-not-found/);
  });

  it("the command kind follows what the step WAITS for: a step waiting for the host inventory mints the inventory script, not the migrator loop (R2/C6)", async () => {
    const { w, cmds, create } = setup({ sourceRunner: "coolify-host-loop", waitStep: "DATA_SEED", commandKind: "inventory" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    expect(w.stepStatus(id, "DATA_SEED")).toBe("WAITING_OPERATOR");
    const res = await w.service.command(ACTOR, id, "DATA_SEED", { reissue: false }, HUB);
    expect(res).toMatchObject({ stepKey: "DATA_SEED", kind: "inventory", command: "SCRIPT(inventory,DATA_SEED)" });
    expect(cmds.inputs.at(-1)).toMatchObject({ kind: "inventory", token: TOKEN });
    // an explicit kind still wins
    expect(await w.service.command(ACTOR, id, "DATA_SEED", { reissue: true, kind: "host-loop" }, HUB)).toMatchObject({ kind: "host-loop" });
  });

  it("a step that names no kind keeps the run's default (the host-loop script)", async () => {
    const { w, create } = setup({ sourceRunner: "coolify-host-loop", waitStep: "DATA_SEED" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    expect(await w.service.command(ACTOR, id, "DATA_SEED", { reissue: false }, HUB)).toMatchObject({ kind: "host-loop" });
  });

  it("FREEZE may wait for the inventory too (a skipped data seed leaves the cross-check to the freeze)", async () => {
    const { w, create } = setup({ sourceRunner: "coolify-host-loop", waitStep: "FREEZE", commandKind: "inventory" });
    const id = await create();
    await w.start(id);
    await w.settle(id);
    expect(await w.service.command(ACTOR, id, "FREEZE", { reissue: false }, HUB)).toMatchObject({ stepKey: "FREEZE", kind: "inventory" });
  });

  describe("the rollback of a host-loop freeze after an abort", () => {
    async function aborted() {
      const s = setup({ sourceRunner: "coolify-host-loop", waitStep: "FREEZE", compensate: true });
      const id = await s.create();
      await s.w.start(id);
      await s.w.settle(id);
      await s.w.store.updateStep(id, "FREEZE", { compensation: { freeze: { controller: "host-loop", hosts: ["srv-b", "srv-a"] } } });
      await s.w.service.abort(ACTOR, id, { confirmName: id });
      await s.w.settle(id);
      return { ...s, id };
    }

    it("is obtainable from the product once the run is aborted: a script with NO token, built from the recorded hosts, minted without touching the migration token", async () => {
      const { w, cmds, id } = await aborted();
      expect(w.status(id)).toBe("ABORTED");
      const before = cmds.inputs.length;
      const res = await w.service.command(ACTOR, id, "FREEZE", { reissue: false }, HUB);
      expect(res).toMatchObject({ stepKey: "FREEZE", kind: "host-loop", command: "SCRIPT(host-loop,FREEZE)", shownOnce: true });
      expect(cmds.inputs.slice(before)).toEqual([expect.objectContaining({ step: "FREEZE", kind: "host-loop", token: null, unfreezeHosts: ["srv-b", "srv-a"] })]);
      expect(w.port.calls.filter((c) => c.startsWith("mint:"))).toEqual([]); // no token was minted for it
      // and it can be asked for again
      await expect(w.service.command(ACTOR, id, "FREEZE", { reissue: false }, HUB)).resolves.toMatchObject({ kind: "host-loop" });
      expect(w.sink.audits.find((a) => a.action === "migration.run.command")?.meta).toMatchObject({ step: "FREEZE", unfreeze: true });
    });

    it("exists only for a freeze that a host-loop script performed", async () => {
      const { w, id } = await aborted();
      await w.store.updateStep(id, "FREEZE", { compensation: { freeze: { controller: "manual" } } });
      await expect(w.service.command(ACTOR, id, "FREEZE", { reissue: false }, HUB)).rejects.toThrow(/command-kind-unavailable/);
      await expect(w.service.command(ACTOR, id, "DATA_FINAL", { reissue: false }, HUB)).rejects.toThrow(/run-not-open/); // every other command still needs an open run
    });
  });

  describe("inventory attestations settle ONE finding", () => {
    const finding = { id: "inventory-unlisted-db:abc", status: "fail" as const, code: "inventory.unlisted-db", subject: "host-1/db-ghost", attestable: ["inventory-excluded", "inventory-mapped"] };
    async function waiting() {
      const s = setup({ sourceRunner: "coolify-host-loop", waitStep: "DATA_SEED", attest: ["inventory-excluded", "inventory-mapped"] });
      const id = await s.create();
      await s.w.start(id);
      await s.w.settle(id);
      await s.w.store.updateStep(id, "DATA_SEED", { gate: { passed: false, checks: [finding] } });
      return { ...s, id };
    }

    it("is refused without a subject, or for a subject that is not an open finding of the step's gate, instead of being stored and settling nothing", async () => {
      const { w, id } = await waiting();
      await expect(w.service.evidence(ACTOR, id, "DATA_SEED", { checkId: "inventory-excluded" })).rejects.toThrow(/attest-subject-invalid/);
      await expect(w.service.evidence(ACTOR, id, "DATA_SEED", { checkId: "inventory-excluded", subject: "host-1/another" })).rejects.toThrow(/attest-subject-invalid/);
      await expect(w.service.evidence(ACTOR, id, "DATA_SEED", { checkId: "inventory-excluded", subject: "host-1/db-ghost-2" })).rejects.toThrow(/attest-subject-invalid/);
      expect((await w.view(id)).steps.find((s) => s.key === "DATA_SEED")!.evidence.attestations).toEqual([]);
    });

    it("a mapping must name the plan item in its note; the exact finding is accepted and recorded with its subject", async () => {
      const { w, id } = await waiting();
      await expect(w.service.evidence(ACTOR, id, "DATA_SEED", { checkId: "inventory-mapped", subject: "host-1/db-ghost" })).rejects.toThrow(/attest-note-required/);
      await w.service.evidence(ACTOR, id, "DATA_SEED", { checkId: "inventory-mapped", subject: "host-1/db-ghost", note: "database:host-1:abc" });
      await w.service.evidence(ACTOR, id, "DATA_SEED", { checkId: "inventory-excluded", subject: "host-1/db-ghost" });
      expect((await w.view(id)).steps.find((s) => s.key === "DATA_SEED")!.evidence.attestations.map((a) => [a.checkId, a.subject])).toEqual([
        ["inventory-mapped", "host-1/db-ghost"],
        ["inventory-excluded", "host-1/db-ghost"],
      ]);
    });

    it("an inventory check that does not allow that attestation (a mapping for an orphan volume) is refused too", async () => {
      const { w, id } = await waiting();
      await w.store.updateStep(id, "DATA_SEED", { gate: { passed: false, checks: [{ ...finding, id: "inventory-orphan-volume:x", subject: "host-1/volume:v", attestable: ["inventory-excluded"] }] } });
      await expect(w.service.evidence(ACTOR, id, "DATA_SEED", { checkId: "inventory-mapped", subject: "host-1/volume:v", note: "database:host-1:abc" })).rejects.toThrow(/attest-subject-invalid/);
    });
  });
});
