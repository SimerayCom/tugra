import { ConfigService } from "@nestjs/config";
import { InstallController } from "./install.controller";
import type { UpdateService } from "../update/update.service";

function make(vars: Record<string, string | undefined> = {}, verifyLatestEntry?: jest.Mock) {
  const config = { get: (k: string) => vars[k] } as unknown as ConfigService;
  const update = { verifyLatestEntry: verifyLatestEntry ?? jest.fn().mockResolvedValue({ status: "unconfigured" }) } as unknown as UpdateService;
  return { ctrl: new InstallController(config, update), update };
}

describe("InstallController", () => {
  const savedVersion = process.env.TUGRA_VERSION;
  afterEach(() => {
    if (savedVersion === undefined) delete process.env.TUGRA_VERSION;
    else process.env.TUGRA_VERSION = savedVersion;
  });

  it("serves a script pinned to the hub version by default (bare tag when no manifest)", async () => {
    process.env.TUGRA_VERSION = "0.4.2";
    const out = await make().ctrl.agentScript();
    expect(out).toContain("#!/bin/sh");
    expect(out).toContain('IMAGE="ghcr.io/mrcandev/tugra-agent:0.4.2"');
    expect(out).toContain("docker run -d");
    expect(out).not.toContain("@sha256:"); // no digest available → bare tag
  });

  it("falls back to the 0.0.0-dev tag when TUGRA_VERSION is unset", async () => {
    delete process.env.TUGRA_VERSION;
    expect(await make().ctrl.agentScript()).toContain('IMAGE="ghcr.io/mrcandev/tugra-agent:0.0.0-dev"');
  });

  it("honours the AGENT_IMAGE override and never fetches the manifest", async () => {
    const { ctrl, update } = make({ AGENT_IMAGE: "registry.internal/tugra-agent:pinned" });
    const out = await ctrl.agentScript();
    expect(out).toContain('IMAGE="registry.internal/tugra-agent:pinned"');
    expect(out).not.toContain("ghcr.io/mrcandev");
    expect(update.verifyLatestEntry).not.toHaveBeenCalled(); // a mirror can't be pinned to the ghcr digest
  });

  it("pins to the per-arch digest when the signed manifest matches this hub's version", async () => {
    process.env.TUGRA_VERSION = "0.4.2";
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    const verify = jest.fn().mockResolvedValue({ status: "ok", channel: "stable", entry: { version: "0.4.2", agentSha256: { amd64: A, arm64: B } } });
    const out = await make({}, verify).ctrl.agentScript();
    expect(out).toContain('uname -m');
    expect(out).toContain(`x86_64|amd64) IMAGE="ghcr.io/mrcandev/tugra-agent:0.4.2@sha256:${A}"`);
    expect(out).toContain(`aarch64|arm64) IMAGE="ghcr.io/mrcandev/tugra-agent:0.4.2@sha256:${B}"`);
  });

  it("does NOT pin when the manifest's latest version differs from this hub's version", async () => {
    process.env.TUGRA_VERSION = "0.4.2";
    const verify = jest.fn().mockResolvedValue({ status: "ok", channel: "stable", entry: { version: "0.5.0", agentSha256: { amd64: "a".repeat(64), arm64: "b".repeat(64) } } });
    const out = await make({}, verify).ctrl.agentScript();
    expect(out).not.toContain("@sha256:");
    expect(out).toContain('IMAGE="ghcr.io/mrcandev/tugra-agent:0.4.2"');
  });

  it("degrades to the bare tag (no 500) when the manifest carries a malformed digest", async () => {
    process.env.TUGRA_VERSION = "0.4.2";
    // A validly-signed but malformed digest (uppercase / wrong length / prefixed) must NOT reach the renderer.
    const verify = jest.fn().mockResolvedValue({ status: "ok", channel: "stable", entry: { version: "0.4.2", agentSha256: { amd64: "A".repeat(64), arm64: "b".repeat(64) } } });
    const out = await make({}, verify).ctrl.agentScript();
    expect(out).not.toContain("@sha256:");
    expect(out).toContain('IMAGE="ghcr.io/mrcandev/tugra-agent:0.4.2"'); // bare-tag fallback, not an exception
  });

  it("memoizes the manifest lookup (public/un-throttled endpoint must not fetch per request)", async () => {
    process.env.TUGRA_VERSION = "0.4.2";
    const verify = jest.fn().mockResolvedValue({ status: "unconfigured" });
    const { ctrl } = make({}, verify);
    await ctrl.agentScript();
    await ctrl.agentScript();
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
