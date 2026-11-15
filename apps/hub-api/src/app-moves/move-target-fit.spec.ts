import { cpusetExceedsTarget, gpuNotReadyOnTarget, gpusUnavailableOnTarget, hasHostMounts, hasPrivilegedGrant, privilegedOptionsCarried } from "./move-target-fit";

const inv = (over: Record<string, unknown> = {}) => ({
  v: 1,
  gpus: [{ index: 0, uuid: null, name: "A100", vendor: "nvidia", kind: "gpu", memoryMb: 40960, driver: "550.54", pci: null, source: "nvidia-smi" }],
  runtimes: ["runc", "nvidia"],
  defaultRuntime: "runc",
  nvidiaRuntime: true,
  nvidiaDriverLoaded: true,
  nvidiaModuleVersion: "550.54",
  error: null,
  ...over,
});
const NVIDIA_READY = inv();

describe("move-target-fit", () => {
  it("cpusetExceedsTarget: only when the core count is KNOWN and the set names a missing core", () => {
    expect(cpusetExceedsTarget("0-3", 3)).toBe(true); // core 3 does not exist on a 3-core host (cores 0-2)
    expect(cpusetExceedsTarget("0-3", 4)).toBe(false);
    expect(cpusetExceedsTarget("0,7", 8)).toBe(false);
    expect(cpusetExceedsTarget("0,8", 8)).toBe(true);
    expect(cpusetExceedsTarget("0-3", null)).toBe(false); // unknown core count never counts
    expect(cpusetExceedsTarget(null, 2)).toBe(false);
    expect(cpusetExceedsTarget("", 2)).toBe(false);
  });

  it("gpuNotReadyOnTarget is strict (anything but ready), gpusUnavailableOnTarget (clone) only flags none/non_nvidia", () => {
    expect(gpuNotReadyOnTarget({ gpus: "all" }, null)).toBe(true); // unprobed target: not positively ready
    expect(gpusUnavailableOnTarget({ gpus: "all" }, null)).toBe(false); // clone: unknown never warns
    expect(gpuNotReadyOnTarget({ gpus: "all" }, NVIDIA_READY)).toBe(false);
    expect(gpuNotReadyOnTarget({ gpus: null }, null)).toBe(false); // no GPU request, nothing to check
    expect(gpuNotReadyOnTarget({ gpus: "all", clusterId: "c1" }, null)).toBe(false); // swarm apps are cluster-scheduled
    expect(gpusUnavailableOnTarget({ gpus: "all" }, inv({ gpus: [], nvidiaRuntime: false, nvidiaDriverLoaded: false }))).toBe(true);
  });

  it("hasHostMounts / privileged helpers", () => {
    expect(hasHostMounts([{ hostPath: "/a", containerPath: "/b" }])).toBe(true);
    expect(hasHostMounts([])).toBe(false);
    expect(hasHostMounts(null)).toBe(false);
    expect(privilegedOptionsCarried({ allowPrivilegedDockerOptions: true, dockerOptions: "--privileged" })).toBe(true);
    expect(privilegedOptionsCarried({ allowPrivilegedDockerOptions: true, dockerOptions: null })).toBe(false);
    expect(hasPrivilegedGrant({ allowPrivilegedDockerOptions: true })).toBe(true); // a move also refuses the bare grant
    expect(hasPrivilegedGrant({ allowPrivilegedDockerOptions: false })).toBe(false);
  });
});
