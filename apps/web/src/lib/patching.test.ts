import { describe, it, expect } from "vitest";
import { containerRuntimeUpdates, isAgentDropError, isContainerRuntimePackage, isTransientPatchError, summarizeApply } from "./patching";

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
    expect(summarizeApply([{ name: "a" }, { name: "b" }, { name: "c" }], after(["c"]))).toEqual({ updated: 2, remaining: 1 });
  });
  it("is all-remaining when nothing changed and ignores packages that newly appeared", () => {
    expect(summarizeApply([{ name: "a" }], after(["a"]))).toEqual({ updated: 0, remaining: 1 });
    expect(summarizeApply([{ name: "a" }], after(["z"]))).toEqual({ updated: 1, remaining: 1 });
  });
  it("is null when the fresh check cannot be trusted", () => {
    expect(summarizeApply([{ name: "a" }], after([], { checkFailed: true }))).toBeNull();
    expect(summarizeApply([{ name: "a" }], after([], { supported: false }))).toBeNull();
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
