import { join } from "node:path";
import type { LaunchRecord } from "../handler-util";
import { MigratorRunner } from "./migrator-runner.service";
import { SourceHostFake } from "../testing/source-host-fake";
import { FakeCaps, FakeDataPort, makeCtx, makeRun, makeSnap, volume } from "../testing/fakes";

const run = makeRun({ topology: "swap-proxy", options: { sourceRunner: "agent" } });

async function untilFinished(runner: MigratorRunner, launch: LaunchRecord) {
  for (let i = 0; i < 100; i++) {
    const st = await runner.status(run, launch);
    if (st?.state === "finished") return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the fake migrator never finished");
}

describe("MigratorRunner: DATA_SEED and DATA_FINAL never share a run directory", () => {
  it("each step counts its own launches, yet their directories differ, so DATA_FINAL really launches and reads its own result", async () => {
    const host = new SourceHostFake({ containers: [] });
    const data = new FakeDataPort(makeSnap({ volumes: [volume("volume:s:a:data")] }));
    const runner = new MigratorRunner(host, data, new FakeCaps(), join(host.dir, "runs"));
    const snap = await data.snapshot();

    // DATA_SEED: an inspect launch and a warm-db launch (seq 1 and 2 of ITS counter)
    const seed1 = makeCtx({ run, key: "DATA_SEED" });
    expect(await runner.launch(seed1.ctx, "inspect", snap)).toEqual({ ok: true });
    const seedLaunch1 = seed1.comp.launch as LaunchRecord;
    await untilFinished(runner, seedLaunch1);
    const seed2 = makeCtx({ run, key: "DATA_SEED", steps: { DATA_SEED: { compensation: seed1.comp } } });
    expect(await runner.launch(seed2.ctx, "warm-db", snap)).toEqual({ ok: true });
    expect(seed2.comp.launch).toMatchObject({ seq: 2, tag: "seed", phase: "warm-db" });
    await untilFinished(runner, seed2.comp.launch as LaunchRecord);

    // DATA_FINAL starts from ITS OWN empty compensation: seq 1, but a different directory
    expect(await runner.status(run, undefined)).toBeNull();
    const fin = makeCtx({ run, key: "DATA_FINAL" });
    expect(await runner.launch(fin.ctx, "final", snap)).toEqual({ ok: true });
    const finLaunch = fin.comp.launch as LaunchRecord;
    expect(finLaunch).toMatchObject({ seq: 1, tag: "final", phase: "final" });
    // not an `already` answer: the final launch really started the migrator, with the final flags, as a new run
    expect(host.file(`runs/${run.id}-seed-1/started`)).not.toBeNull();
    expect(host.file(`runs/${run.id}-seed-2/started`)).not.toBeNull();
    expect(host.file(`runs/${run.id}-final-1/started`)).not.toBeNull();
    const st = await untilFinished(runner, finLaunch);
    expect(st.state).toBe("finished");
    expect(host.file("migrator.invocation")).toContain("--resync");
    expect(fin.comp.launchSeq).toBe(1); // the budget of DATA_FINAL is untouched by DATA_SEED's launches
    host.dispose();
  });

  it("a record written before the tag existed still reads its original directory", async () => {
    const host = new SourceHostFake({ containers: [] });
    const data = new FakeDataPort(makeSnap());
    const runner = new MigratorRunner(host, data, new FakeCaps(), join(host.dir, "runs"));
    const old = makeCtx({ run, key: "DATA_FINAL" });
    expect(await runner.launch(old.ctx, "final", await data.snapshot())).toEqual({ ok: true });
    const legacy: LaunchRecord = { seq: 1, phase: "final", at: "x" }; // no tag: `<runId>-1`
    expect(await runner.status(run, legacy)).toEqual({ state: "none" });
    host.dispose();
  });
});
