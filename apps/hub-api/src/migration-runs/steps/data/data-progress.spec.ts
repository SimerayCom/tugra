import { byteProgress } from "./data-logic";
import { inspected, makeSnap, volume } from "./testing/fakes";

const GiB = 1024 ** 3;

describe("byteProgress: bytes, percent and time left of the data that is moving", () => {
  it("is null while nothing is being copied", () => {
    expect(byteProgress(makeSnap({ volumes: [] }))).toBeNull();
    expect(byteProgress(makeSnap({ volumes: [inspected("volume:s:a:data", GiB)] }))).toBeNull();
  });

  it("sums every row, counts a finished row as done and divides what is left by the rows' own rate", () => {
    const snap = makeSnap({
      volumes: [
        inspected("volume:s:a:data", 10 * GiB, 1, { state: "COPYING", rawBytesDone: 2 * GiB, bps: 100 * 1024 ** 2 }),
        inspected("volume:s:b:data", 5 * GiB, 1, { state: "DONE", rawBytesDone: 5 * GiB }),
      ],
    });
    const p = byteProgress(snap)!;
    expect(p).toMatchObject({ unit: "byte", total: 15 * GiB, done: 7 * GiB });
    expect(p.etaSec).toBe(Math.ceil((8 * GiB) / (100 * 1024 ** 2)));
  });

  it("has no time left without a rate, and never reports a percentage over an unknown total", () => {
    const noRate = byteProgress(makeSnap({ volumes: [inspected("volume:s:a:data", GiB, 1, { state: "COPYING", rawBytesDone: 1 })] }))!;
    expect(noRate.etaSec).toBeNull();
    expect(byteProgress(makeSnap({ volumes: [volume("volume:s:a:data", { state: "COPYING", rawBytesTotal: null, inventory: null })] }))).toBeNull();
  });

  it("ignores an excluded volume and never lets done pass the total", () => {
    const snap = makeSnap({
      volumes: [
        inspected("volume:s:a:data", GiB, 1, { state: "COPYING", rawBytesDone: 3 * GiB, bps: 1024 }),
        inspected("volume:s:x:data", 99 * GiB, 1, { state: "COPYING", excluded: true }),
      ],
    });
    expect(byteProgress(snap)).toMatchObject({ total: GiB, done: GiB, etaSec: 0 });
  });
});
