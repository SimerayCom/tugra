import { describe, it, expect } from "vitest";
import { containerRuntimeUpdates, isContainerRuntimePackage } from "./patching";

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
