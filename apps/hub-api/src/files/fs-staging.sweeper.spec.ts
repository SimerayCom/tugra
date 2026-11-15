import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FilesStagingSweeper } from "./fs-staging.sweeper";

describe("FilesStagingSweeper", () => {
  const saved = { ...process.env };
  let dir: string;
  const old = new Date(Date.now() - 3 * 3600_000);
  /** Poll (the sweep is fire-and-forget) instead of sleeping a fixed time, so a loaded machine cannot flake the test. */
  const untilEmpty = async () => {
    for (let i = 0; i < 100; i++) {
      if ((await readdir(dir)).length === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const orphan = async (name: string) => {
    await writeFile(path.join(dir, name), "x");
    await utimes(path.join(dir, name), old, old);
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "fs-sweep-"));
    process.env.FILES_STAGING_DIR = dir;
  });
  afterEach(async () => {
    process.env = { ...saved };
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("sweeps once at boot, again every hour, and stops on shutdown", async () => {
    await orphan("11111111-1111-1111-1111-111111111111.part");
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const setIntervalSpy = jest.spyOn(global, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
      intervals.push({ fn, ms });
      return { unref: jest.fn() } as unknown as NodeJS.Timeout;
    }) as never);
    const clearSpy = jest.spyOn(global, "clearInterval").mockImplementation(() => undefined);

    const sweeper = new FilesStagingSweeper();
    sweeper.onModuleInit();
    await untilEmpty();
    expect(await readdir(dir)).toEqual([]); // the boot sweep removed the orphan

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(intervals[0].ms).toBe(60 * 60 * 1000);
    await orphan("22222222-2222-2222-2222-222222222222.part");
    intervals[0].fn(); // the hourly tick
    await untilEmpty();
    expect(await readdir(dir)).toEqual([]);

    sweeper.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalled();
  });
});
