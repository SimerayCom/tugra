import { runCommandsFor, phaseFor } from "./run-commands";
import { answered, copied, database, inspected, makeRun, makeSnap, volume } from "./testing/fakes";

const TOKEN = `tugra_mig_${"A".repeat(43)}`;
const BASE = "https://hub.example.com";

describe("runCommandsFor", () => {
  it("DATA_SEED: the dry-run is the main command until every volume was inspected", () => {
    const c = runCommandsFor("DATA_SEED", TOKEN, BASE, makeRun(), makeSnap({ volumes: [volume("v")] }))!;
    expect(c.command).toBe(`curl -fsSL ${BASE}/install/migrator.sh | TUGRA_MIGRATION_TOKEN=${TOKEN} sh -s -- --hub ${BASE}`);
    expect(c.commands.dryRun).toBe(`${c.command} --arms all --dry-run --measure-dbs`);
    expect(c.commands.run).toBe(c.commands.dryRun);
  });
  it("DATA_SEED with the warm database seed: databases-only once the volumes are inspected", () => {
    const run = makeRun({ options: { warmDbSeed: true } });
    const snap = makeSnap({ volumes: [inspected("v")], databases: [database("d", { task: "none" })] });
    expect(runCommandsFor("DATA_SEED", TOKEN, BASE, run, snap)!.commands.run).toMatch(/--arms databases$/);
    expect(phaseFor("DATA_SEED", run, makeSnap({ volumes: [volume("v")], databases: [database("d")] }))).toBe("inspect");
    expect(phaseFor("DATA_SEED", makeRun(), snap)).toBe("inspect");
  });
  it("DATA_FINAL: resync + verify, following the run's options, and the same flags the launcher uses", () => {
    const run = makeRun({ options: { stopSource: true, certs: "seed" }, inputs: { allowBind: answered(true) } });
    const c = runCommandsFor("DATA_FINAL", TOKEN, BASE, run, makeSnap({ volumes: [copied("v")] }))!;
    expect(c.commands.run).toBe(`${c.command} --arms all --resync --verify --verify-mode estimate --hub-outage-wait 30m --stop-source --allow-bind --certs`);
    expect(c.commands.resume).toBe(c.commands.run);
    expect(c.commands.dryRun).toBe(`${c.command} --arms all --dry-run --measure-dbs`);
    expect(c.command).not.toContain("--certs"); // the flag travels once, with the final run
  });
  it("other steps have no migrator command", () => {
    for (const k of ["FREEZE", "VERIFY", "IMPORT", "CUTOVER"] as const) expect(runCommandsFor(k, TOKEN, BASE, makeRun())).toBeNull();
  });
  it("refuses a malformed token or an unsafe hub base (nothing is built)", () => {
    expect(() => runCommandsFor("DATA_FINAL", "tugra_mig_short", BASE, makeRun())).toThrow();
    expect(() => runCommandsFor("DATA_FINAL", TOKEN, "https://x;rm -rf /", makeRun())).toThrow();
  });
});
