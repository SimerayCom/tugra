import { ConfigService } from "@nestjs/config";
import { InstallController } from "./install.controller";

function make(vars: Record<string, string | undefined> = {}) {
  const config = { get: (k: string) => vars[k] } as unknown as ConfigService;
  return new InstallController(config);
}

describe("InstallController", () => {
  const savedVersion = process.env.TUGRA_VERSION;
  afterEach(() => {
    if (savedVersion === undefined) delete process.env.TUGRA_VERSION;
    else process.env.TUGRA_VERSION = savedVersion;
  });

  it("serves a script pinned to the hub version by default", () => {
    process.env.TUGRA_VERSION = "0.4.2";
    const out = make().agentScript();
    expect(out).toContain("#!/bin/sh");
    expect(out).toContain('IMAGE="ghcr.io/mrcandev/tugra-agent:0.4.2"');
    expect(out).toContain("docker run -d");
  });

  it("falls back to the 0.0.0-dev tag when TUGRA_VERSION is unset", () => {
    delete process.env.TUGRA_VERSION;
    expect(make().agentScript()).toContain('IMAGE="ghcr.io/mrcandev/tugra-agent:0.0.0-dev"');
  });

  it("honours the AGENT_IMAGE override", () => {
    const out = make({ AGENT_IMAGE: "registry.internal/tugra-agent:pinned" }).agentScript();
    expect(out).toContain('IMAGE="registry.internal/tugra-agent:pinned"');
    expect(out).not.toContain("ghcr.io/mrcandev");
  });
});
