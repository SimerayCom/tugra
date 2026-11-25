import { describe, it, expect } from "vitest";
import { ApiError } from "./api";
import { HUB_UNREACHABLE_CODE } from "./hub-connection";
import { containerRuntimeUpdates, groupPackages, onlyEngineLeft, interruptedNames, isAgentDropError, isContainerRuntimePackage, isTransientPatchError, phasedToastKey, settledApplyLog, shouldToastReboot, summarizeApply } from "./patching";

describe("containerRuntimeUpdates", () => {
  it("picks docker-ce, containerd.io and runc out of the pending list", () => {
    const pkgs = [{ name: "curl" }, { name: "docker-ce" }, { name: "runc" }, { name: "containerd.io" }, { name: "openssl" }];
    expect(containerRuntimeUpdates(pkgs)).toEqual(["docker-ce", "runc", "containerd.io"]);
  });
  it("does not flag look-alikes that restart nothing", () => {
    expect(containerRuntimeUpdates([{ name: "docker-ce-cli" }, { name: "docker-compose-plugin" }, { name: "containerd" }])).toEqual([]);
    expect(isContainerRuntimePackage("runc")).toBe(true);
    expect(isContainerRuntimePackage("runc-doc")).toBe(false);
  });
  it("is empty for an empty list", () => {
    expect(containerRuntimeUpdates([])).toEqual([]);
  });
});

const e = (status: number, message: string) => Object.assign(new Error(message), { status });
const after = (names: string[], o: Record<string, unknown> = {}) => ({ supported: true, checkFailed: false, packages: names.map((name) => ({ name })), count: names.length, ...o });

describe("summarizeApply", () => {
  it("counts packages that left the list as updated and the rest as remaining", () => {
    expect(summarizeApply([{ name: "a" }, { name: "b" }, { name: "c" }], after(["c"]))).toEqual({ updated: 2, remaining: 1, phased: 0 });
  });
  it("is all-remaining when nothing changed and ignores packages that newly appeared", () => {
    expect(summarizeApply([{ name: "a" }], after(["a"]))).toEqual({ updated: 0, remaining: 1, phased: 0 });
    expect(summarizeApply([{ name: "a" }], after(["z"]))).toEqual({ updated: 1, remaining: 1, phased: 0 });
  });
  it("a package that moved to the phased list is deferred, not updated and not pending", () => {
    const r = summarizeApply([{ name: "snapd" }, { name: "vim" }], after([], { phased: [{ name: "snapd" }] }));
    expect(r).toEqual({ updated: 1, remaining: 0, phased: 1 });
  });
  it("a package still phased after a forced install is not counted as updated", () => {
    expect(summarizeApply([{ name: "snapd" }], after([], { phased: [{ name: "snapd" }] }))).toEqual({ updated: 0, remaining: 0, phased: 1 });
    expect(summarizeApply([{ name: "snapd" }], after([], { phased: [] }))).toEqual({ updated: 1, remaining: 0, phased: 0 });
  });
  it("is null when the fresh check cannot be trusted", () => {
    expect(summarizeApply([{ name: "a" }], after([], { checkFailed: true }))).toBeNull();
    expect(summarizeApply([{ name: "a" }], after([], { supported: false }))).toBeNull();
  });
});

describe("phasedToastKey", () => {
  it("names phasing only when something was deferred by it", () => {
    expect(phasedToastKey({ updated: 0, remaining: 0, phased: 0 })).toBeNull();
    expect(phasedToastKey({ updated: 0, remaining: 0, phased: 1 })).toBe("patching.appliedPhased");
    expect(phasedToastKey({ updated: 2, remaining: 0, phased: 1 })).toBe("patching.appliedPhasedSome");
  });
});

describe("apply error classification", () => {
  it("treats an agent drop / hub timeout / network failure as a restart", () => {
    expect(isAgentDropError(e(503, "agent disconnected"))).toBe(true);
    expect(isAgentDropError(e(503, "The agent is offline — try again once it reconnects."))).toBe(true);
    expect(isAgentDropError(e(504, "command timed out"))).toBe(true);
    expect(isAgentDropError(new TypeError("Failed to fetch"))).toBe(true);
  });
  it("does not treat a refusal or a host-patching failure as a restart", () => {
    expect(isAgentDropError(e(403, "forbidden"))).toBe(false);
    expect(isAgentDropError(e(503, "a patch is already running on this server — wait for it to finish"))).toBe(false);
    expect(isAgentDropError(e(503, "host patching unavailable: no-image"))).toBe(false);
  });
  it("retries only transient re-check failures", () => {
    expect(isTransientPatchError(e(503, "offline"))).toBe(true);
    expect(isTransientPatchError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientPatchError(e(403, "no"))).toBe(false);
    expect(isTransientPatchError(e(404, "gone"))).toBe(false);
  });
});

describe("apply error classification with the real API client errors", () => {
  it("treats a wrapped network failure (ApiError 0) as an agent drop and a transient re-check failure", () => {
    const err = new ApiError(0, "Hub is restarting or unreachable", HUB_UNREACHABLE_CODE);
    expect(isAgentDropError(err)).toBe(true);
    expect(isTransientPatchError(err)).toBe(true);
  });
  it("treats proxy and Cloudflare gateway answers on the long apply as a drop", () => {
    expect(isAgentDropError(new ApiError(502, "Hub is restarting or unreachable", HUB_UNREACHABLE_CODE))).toBe(true);
    expect(isAgentDropError(new ApiError(524, "HTTP 524"))).toBe(true);
    expect(isAgentDropError(new ApiError(522, "HTTP 522"))).toBe(true);
    expect(isTransientPatchError(new ApiError(524, "HTTP 524"))).toBe(true);
  });
  it("still treats a definitive refusal as a real error", () => {
    expect(isAgentDropError(new ApiError(403, "forbidden"))).toBe(false);
    expect(isAgentDropError(new ApiError(409, "a patch is already running"))).toBe(false);
    expect(isTransientPatchError(new ApiError(403, "forbidden"))).toBe(false);
  });
});

describe("settledApplyLog", () => {
  it("keeps the streamed lines when the agent dropped before the hub answered", () => {
    expect(settledApplyLog(null, "Unpacking docker-ce\n")).toBe("Unpacking docker-ce\n");
    expect(settledApplyLog("", "streamed")).toBe("streamed");
  });
  it("prefers the hub's final output", () => {
    expect(settledApplyLog("final", "streamed")).toBe("final");
  });
});

describe("shouldToastReboot", () => {
  const sys = { supported: true, rebootRequired: true };
  it("fires only after a successful run that updated something", () => {
    expect(shouldToastReboot(0, { updated: 2, remaining: 0 }, sys)).toBe(true);
  });
  it("stays quiet after a failed run, a no-op run, an unknown outcome or no pending reboot", () => {
    expect(shouldToastReboot(100, { updated: 2, remaining: 1 }, sys)).toBe(false);
    expect(shouldToastReboot(0, { updated: 0, remaining: 1 }, sys)).toBe(false);
    expect(shouldToastReboot(0, null, sys)).toBe(false);
    expect(shouldToastReboot(0, { updated: 1, remaining: 0 }, { supported: true, rebootRequired: false })).toBe(false);
    expect(shouldToastReboot(0, { updated: 1, remaining: 0 }, { supported: false, rebootRequired: true })).toBe(false);
  });
});

describe("interruptedNames", () => {
  it("lists the half-configured packages, empty when dpkg is clean", () => {
    expect(interruptedNames({ dpkgInterrupted: { packages: [{ name: "docker-ce", state: "half-configured" }, { name: "vim", state: "unpacked" }], containerEngine: true } })).toEqual(["docker-ce", "vim"]);
    expect(interruptedNames({ dpkgInterrupted: null })).toEqual([]);
  });
});

describe("groupPackages / onlyEngineLeft", () => {
  it("splits by group in list order; a package without a group (older hub) is 'other'", () => {
    const g = groupPackages([{ name: "a", group: "other" as const }, { name: "b", group: "engine" as const }, { name: "c" }, { name: "d", group: "kernel" as const }, { name: "e", group: "engine" as const }]);
    expect(g.engine.map((p) => p.name)).toEqual(["b", "e"]);
    expect(g.kernel.map((p) => p.name)).toEqual(["d"]);
    expect(g.other.map((p) => p.name)).toEqual(["a", "c"]);
  });
  it("is empty per group for an empty list", () => {
    expect(groupPackages([])).toEqual({ engine: [], kernel: [], other: [] });
  });
  it("onlyEngineLeft is true only when something is left and all of it is the engine", () => {
    expect(onlyEngineLeft({ packages: [{ group: "engine" }, { group: "engine" }] })).toBe(true);
    expect(onlyEngineLeft({ packages: [{ group: "engine" }, { group: "other" }] })).toBe(false);
    expect(onlyEngineLeft({ packages: [{}] })).toBe(false);
    expect(onlyEngineLeft({ packages: [] })).toBe(false);
  });
});
