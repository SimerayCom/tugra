import { buildCloudInitUserData } from "./cloud-init";
import { HETZNER_DEFAULT_IMAGE, HETZNER_IMAGES, isValidHetznerImage, isValidHetznerLocation, isValidHetznerServerType } from "./hetzner-catalog";

describe("buildCloudInitUserData", () => {
  const install = "curl -fsSL https://hub.example.com/install/agent.sh | sh -s -- --hub wss://hub.example.com/agent --token tugra_en_abc";

  it("installs Docker before running the agent installer, and embeds the install command verbatim", () => {
    const s = buildCloudInitUserData(install);
    expect(s.startsWith("#!/bin/sh")).toBe(true);
    expect(s).toContain("set -eu");
    expect(s).toContain("curl -fsSL https://get.docker.com | sh");
    expect(s).toContain(install);
    // Docker must be installed BEFORE the agent installer runs (installer hard-fails without docker).
    expect(s.indexOf("get.docker.com")).toBeLessThan(s.indexOf("install/agent.sh"));
  });

  it("throws on an empty install command", () => {
    expect(() => buildCloudInitUserData("")).toThrow(/must not be empty/);
    expect(() => buildCloudInitUserData("   ")).toThrow(/must not be empty/);
  });

  it("only ever carries what the caller passed (no place a provider API token could leak in)", () => {
    // Regression guard: the builder must not inject anything beyond docker-install + the command.
    const s = buildCloudInitUserData(install);
    const extra = s.replace(install, "").replace("curl -fsSL https://get.docker.com | sh", "");
    expect(extra).not.toMatch(/token|secret|bearer|api[-_]?key/i);
  });
});

describe("hetzner-catalog", () => {
  it("validates known location / server-type / image values", () => {
    expect(isValidHetznerLocation("nbg1")).toBe(true);
    expect(isValidHetznerLocation("moon-base")).toBe(false);
    expect(isValidHetznerServerType("cx22")).toBe(true);
    expect(isValidHetznerServerType("cx11")).toBe(false); // deprecated line — not offered
    expect(isValidHetznerImage("ubuntu-24.04")).toBe(true);
    expect(isValidHetznerImage("windows")).toBe(false);
  });

  it("has the default image in the image list", () => {
    expect(HETZNER_IMAGES.some((i) => i.value === HETZNER_DEFAULT_IMAGE)).toBe(true);
  });
});
