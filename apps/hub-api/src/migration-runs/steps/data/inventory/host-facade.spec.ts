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
function setup(opts: { sourceRunner: "operator" | "coolify-host-loop"; waitStep?: "DATA_FINAL" | "FREEZE" }) {
  const act = async (): Promise<ActResult> => ({ outcome: "wait", wait: { kind: "operator", code: "data.run-migrator", offersCommand: true, attest: ["freeze-containers-unresolved"] } });
  const w = new RunWorld({ stubs: { [opts.waitStep ?? "DATA_FINAL"]: { act } } });
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
});
