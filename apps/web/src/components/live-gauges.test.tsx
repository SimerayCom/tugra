import { describe, it, expect } from "vitest";
import { buildGauges } from "./live-gauges";
import type { MetricsSample } from "../lib/types";

// Identity translator so assertions read on the raw key (the real t() is covered elsewhere).
const t = (k: string) => k;

const base: MetricsSample = {
  ts: 1000,
  cpu: 42,
  memUsed: 2 * 1024 ** 3,
  memTotal: 8 * 1024 ** 3,
  diskUsed: 10 * 1024 ** 3,
  diskTotal: 100 * 1024 ** 3,
  netRx: 0,
  netTx: 0,
  diskRead: 0,
  diskWrite: 0,
};

describe("buildGauges", () => {
  it("always emits cpu/mem/disk, and nothing else when the host reports no sensors", () => {
    const g = buildGauges(base, t);
    expect(g.map((x) => x.key)).toEqual(["cpu", "mem", "disk"]);
    expect(g[0]).toMatchObject({ value: 42, tone: "ok", text: "42%" });
    expect(g[1].text).toContain("25%"); // 2/8 GiB
    expect(g[2].text).toContain("10%"); // 10/100 GiB
  });

  it("adds a temperature gauge on a 0..100 °C scale with the warn/crit tone", () => {
    const g = buildGauges({ ...base, temp: 88 }, t);
    const temp = g.find((x) => x.key === "temp")!;
    expect(temp.value).toBe(88);
    expect(temp.tone).toBe("crit"); // ≥85 °C
    expect(temp.text).toBe("88°C");
  });

  it("clamps a wild temperature's BAR fill to 100 but keeps the real number in the label", () => {
    const g = buildGauges({ ...base, temp: 130 }, t);
    const temp = g.find((x) => x.key === "temp")!;
    expect(temp.value).toBe(100);
    expect(temp.text).toBe("130°C");
  });

  it("emits one gauge per GPU, max-util tone, VRAM + temp in the label", () => {
    const g = buildGauges(
      { ...base, gpus: [{ name: "RTX 4090", util: 95, memUsed: 12 * 1024 ** 3, memTotal: 24 * 1024 ** 3, temp: 71 }] },
      t,
    );
    const gpu = g.find((x) => x.key === "gpu-0")!;
    expect(gpu.value).toBe(95);
    expect(gpu.tone).toBe("crit"); // 95% util ≥ 90
    expect(gpu.label).toContain("RTX 4090");
    expect(gpu.text).toContain("71°C");
    expect(gpu.text).toContain("GB");
  });

  it("battery tone is LOW-is-bad and shows the charge state", () => {
    const low = buildGauges({ ...base, battery: { percent: 8, state: "Discharging" } }, t).find((x) => x.key === "battery")!;
    expect(low.tone).toBe("crit");
    expect(low.text).toBe("8% · Discharging");
    const charging = buildGauges({ ...base, battery: { percent: 8, state: "Charging" } }, t).find((x) => x.key === "battery")!;
    expect(charging.tone).toBe("ok"); // charging is never alarming
  });

  it("a non-finite field degrades to a dash, not a crash", () => {
    const g = buildGauges({ ...base, cpu: NaN as unknown as number }, t);
    expect(g[0].text).toBe("—");
    expect(g[0].value).toBeNull();
  });
});
