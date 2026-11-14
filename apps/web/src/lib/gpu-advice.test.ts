import { describe, it, expect } from "vitest";
import { gpusAdvice } from "./gpu-advice";
import type { GpuDevice, GpuReadiness, GpuReport } from "./types";

const U0 = "GPU-12345678-aaaa-bbbb-cccc-000000000000";
const U1 = "GPU-12345678-aaaa-bbbb-cccc-111111111111";
const smi = (index: number, uuid: string | null): GpuDevice => ({ index, uuid, name: "RTX", vendor: "nvidia", kind: "gpu", memoryMb: 1, driver: "1", pci: null, source: "nvidia-smi" });
const report = (readiness: GpuReadiness, gpus: GpuDevice[] = []): GpuReport => ({
  inventory: { v: 1, gpus, runtimes: [], defaultRuntime: null, nvidiaRuntime: true, nvidiaDriverLoaded: true, nvidiaModuleVersion: null, error: null },
  readiness,
  checkedAt: "2026-11-17T12:00:00Z",
  ageSeconds: 1,
  stale: false,
  ttlSeconds: 600,
});
const ready2 = report("ready", [smi(0, U0), smi(1, U1)]);

describe("gpusAdvice", () => {
  it("is silent for empty values, cluster apps, a missing report and unknown", () => {
    expect(gpusAdvice("", report("none"))).toBeNull();
    expect(gpusAdvice("   ", report("none"))).toBeNull();
    expect(gpusAdvice("all", report("none"), "c1")).toBeNull();
    expect(gpusAdvice("all", undefined)).toBeNull();
    expect(gpusAdvice("all", null)).toBeNull();
    expect(gpusAdvice("all", { ...report("unknown"), inventory: null })).toBeNull();
  });

  it("maps each non-ready readiness to its key", () => {
    expect(gpusAdvice("all", report("none"))).toEqual({ key: "noGpu" });
    expect(gpusAdvice("all", report("non_nvidia"))).toEqual({ key: "nonNvidia" });
    expect(gpusAdvice("all", report("driver_missing"))).toEqual({ key: "noDriver" });
    expect(gpusAdvice("all", report("runtime_missing"))).toEqual({ key: "runtimeUnconfirmed" });
  });

  it("probe_failed without smi rows stays silent", () => {
    expect(gpusAdvice("all", report("probe_failed"))).toBeNull();
  });

  it("checks a numeric count against the K detected GPUs", () => {
    expect(gpusAdvice("all", ready2)).toBeNull();
    expect(gpusAdvice("2", ready2)).toBeNull();
    expect(gpusAdvice("3", ready2)).toEqual({ key: "countExceeds", params: { n: 2 } });
  });

  it("checks device= indexes and uuids", () => {
    expect(gpusAdvice("device=0,1", ready2)).toBeNull();
    expect(gpusAdvice("device=2", ready2)).toEqual({ key: "indexOutOfRange", params: { n: 2 } });
    expect(gpusAdvice("device=0,5", ready2)).toEqual({ key: "indexOutOfRange", params: { n: 2 } });
    expect(gpusAdvice(`device=${U1}`, ready2)).toBeNull();
    expect(gpusAdvice("device=GPU-deadbeef-0000", ready2)).toEqual({ key: "deviceUnknown" });
    expect(gpusAdvice("device=MIG-deadbeef-0000", ready2)).toEqual({ key: "deviceUnknown" });
  });

  it("stays silent on odd tokens it can't judge", () => {
    expect(gpusAdvice("device=foo", ready2)).toBeNull();
  });
});
