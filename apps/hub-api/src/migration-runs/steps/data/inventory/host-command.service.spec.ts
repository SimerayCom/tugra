import { spawnSync } from "node:child_process";
import { HostCommandService } from "./host-command.service";
import { HostCommandError } from "./inventory-contract";
import { FakeDataPort, answered, inspected, makeRun, makeSnap, database, volume } from "../testing/fakes";

const TOKEN = `tugra_mig_${"D".repeat(43)}`;
const HUB = "https://hub.example.test";
const UA = "uuaaaaaaaaaaaaaaaaaaaaaa";
const UB = "uubbbbbbbbbbbbbbbbbbbbbb";
const UC = "uucccccccccccccccccccccc";

const run = (o: Parameters<typeof makeRun>[0] = {}) => makeRun({ ...o, options: { sourceRunner: "coolify-host-loop", ...(o.options ?? {}) }, serverMap: { "srv-a": "t1", "srv-b": "t2", "srv-empty": "t2" } });
const snapshot = () =>
  makeSnap({
    databases: [database(`database:srv-a:${UA}`, { plane: "volume" })],
    volumes: [volume(`volume:srv-a:${UA}:data`), volume(`volume:srv-b:${UB}:data`), volume(`volume:srv-b:${UB}:cache`, { excluded: true })],
    apps: [{ itemRef: `app:srv-a:${UC}`, name: "web" }],
    services: [{ itemRef: `service:srv-b:${UB}`, name: "cache" }],
  });

const svc = (snap = snapshot()) => new HostCommandService(new FakeDataPort(snap));
const input = (over: Partial<Parameters<HostCommandService["build"]>[0]> = {}) => ({ run: run(), step: "DATA_SEED" as const, kind: "host-loop" as const, token: TOKEN, hubBase: HUB, attested: [], ...over });

/** The pasted command is `sh -s <<'EOF' ... EOF`; syntax-check it for real. */
const syntaxOk = (command: string): boolean => spawnSync("sh", ["-n", "-c", command]).status === 0;

describe("HostCommandService", () => {
  it("DATA_SEED: one script for the hosts that have data items, each restricted to ITS items with --only, in the phase's flags", async () => {
    const r = await svc().build(input());
    expect(r.hosts).toEqual(["srv-a", "srv-b"]); // srv-empty has nothing to move and gets no migrator
    expect(r.command.startsWith("sh -s <<'TUGRA_HOST_LOOP_EOF'\n")).toBe(true);
    expect(r.command).toContain(`'srv-a') printf '%s\\n' '--arms' 'all' '--dry-run' '--only' 'database:srv-a:${UA}' '--only' 'volume:srv-a:${UA}:data' ;;`);
    expect(r.command).toContain(`'srv-b') printf '%s\\n' '--arms' 'all' '--dry-run' '--only' 'volume:srv-b:${UB}:data' ;;`); // the excluded volume is not run
    expect(r.command).toContain("cmrun00000001-seed-1"); // inspect phase
    expect(syntaxOk(r.command)).toBe(true);
    expect(r.command.split(TOKEN).length - 1).toBe(1);
  });

  it("DATA_FINAL: the final flags (stop-source, verify, allow-bind) travel with the hosts' --only items, in the final run directory", async () => {
    const final = await svc(makeSnap({ ...snapshot(), volumes: [inspected(`volume:srv-a:${UA}:data`)] })).build(input({ step: "DATA_FINAL", run: run({ options: { stopSource: true, rowCountMode: "estimate" } }) }));
    expect(final.command).toContain("'--stop-source'");
    expect(final.command).toContain("'--verify'");
    expect(final.command).toContain("cmrun00000001-final-1");
    expect(syntaxOk(final.command)).toBe(true);
  });

  it("DATA_SEED after every volume was inspected and warm seeding is on: the warm-db phase (its own run directory)", async () => {
    const snap = snapshot();
    snap.volumes = snap.volumes.map((v) => inspected(v.itemRef, 1, 1, { excluded: v.excluded }));
    snap.databases = [database(`database:srv-a:${UA}`, { plane: "logical", task: "none" })];
    const r = await svc(snap).build(input({ run: run({ options: { warmDbSeed: true } }) }));
    expect(r.command).toContain("'--arms' 'databases'");
    expect(r.command).toContain("cmrun00000001-seed-2");
  });

  it("FREEZE: the hosts that run stop-list items, each with its own items; the attested unresolved guard lifts allowUnresolved", async () => {
    const base = input({ step: "FREEZE", run: run({ inputs: { sourceController: answered("agent" as const) } }) });
    const r = await svc().build(base);
    expect(r.hosts).toEqual(["srv-a", "srv-b"]);
    expect(r.command).toContain(`'srv-a') printf '%s\\n' 'app:srv-a:${UC}' 'database:srv-a:${UA}' ;;`);
    expect(r.command).toContain("F_ALLOW_UNRESOLVED='0'");
    expect(syntaxOk(r.command)).toBe(true);
    const lifted = await svc().build({ ...base, attested: ["freeze-containers-unresolved"] });
    expect(lifted.command).toContain("F_ALLOW_UNRESOLVED='1'");
    expect(lifted.command).not.toContain("F_ALLOW_UNRESOLVED='0'");
  });

  it("INVENTORY through the loop covers every host of the run (also hosts with only apps), with no migrator flags", async () => {
    const r = await svc().build(input({ kind: "inventory" }));
    expect(r.hosts).toEqual(["srv-a", "srv-b", "srv-empty"]);
    expect(r.command).toContain("STEP='INVENTORY'");
    expect(syntaxOk(r.command)).toBe(true);
  });

  it("an inventory for a run that is NOT a host-loop run is the single-host one-liner in inventory mode", async () => {
    const r = await svc().build(input({ kind: "inventory", run: makeRun({ options: { sourceRunner: "operator" } }) }));
    expect(r.command).toBe(`curl -fsSL ${HUB}/install/migrator.sh | TUGRA_MIGRATION_TOKEN=${TOKEN} sh -s -- --hub ${HUB} --inventory`);
    expect(r.hosts).toEqual([]);
  });

  it("refuses with fixed codes: no hosts, a step that has no host-loop, an op that does not exist yet, an unsafe value", async () => {
    await expect(svc(makeSnap({ apps: [], databases: [], volumes: [], services: [] })).build(input({ run: makeRun({ options: { sourceRunner: "coolify-host-loop" } }) }))).rejects.toMatchObject({ code: "no-hosts" });
    await expect(svc().build(input({ step: "VERIFY" }))).rejects.toMatchObject({ code: "step-unsupported" });
    await expect(svc().build(input({ run: { ...run(), opId: null } }))).rejects.toMatchObject({ code: "step-unsupported" });
    await expect(svc().build(input({ token: "tugra_mig_not-a-token" }))).rejects.toBeInstanceOf(HostCommandError);
    const longRef = `volume:srv-a:${UA}:${"v".repeat(80)}`; // a flag word over the 100-char limit
    const snap = snapshot();
    snap.volumes = [volume(longRef)];
    await expect(svc(snap).build(input())).rejects.toMatchObject({ code: "unsafe-input" });
  });

  it("uses the run's host-loop options (key directory, parallelism, timeouts)", async () => {
    const r = await svc().build(input({ run: run({ options: { hostLoop: { keyDir: "/srv/keys", parallel: 3, connectTimeoutSec: 30, retries: 2 } } }) }));
    expect(r.command).toContain("KEYDIR='/srv/keys'");
    expect(r.command).toContain("PAR=3");
    expect(r.command).toContain("CTO=30");
    expect(r.command).toContain("RETRIES=2");
  });
});
