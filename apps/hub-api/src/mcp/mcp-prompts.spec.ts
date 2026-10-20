import { MCP_PROMPTS } from "./mcp-prompts";

describe("MCP_PROMPTS catalog", () => {
  it("every prompt has a valid name, description, argument specs, and a build()", () => {
    expect(MCP_PROMPTS.length).toBeGreaterThan(0);
    expect(new Set(MCP_PROMPTS.map((p) => p.name)).size).toBe(MCP_PROMPTS.length); // unique names
    for (const p of MCP_PROMPTS) {
      expect(p.name).toMatch(/^[a-z_]+$/);
      expect(typeof p.description).toBe("string");
      expect(Array.isArray(p.arguments)).toBe(true);
      for (const a of p.arguments) {
        expect(a.name).toMatch(/^[a-zA-Z_]+$/);
        expect(typeof a.description).toBe("string");
        expect(typeof a.required).toBe("boolean");
      }
      // build() is pure and tolerates missing optionals; required args get interpolated when present.
      const filled = Object.fromEntries(p.arguments.map((a) => [a.name, `V_${a.name}`]));
      const text = p.build(filled);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      for (const a of p.arguments.filter((a) => a.required)) expect(text).toContain(`V_${a.name}`);
    }
  });

  it("fleet_rollout clamps an unknown action to a safe default (never echoes arbitrary text)", () => {
    const p = MCP_PROMPTS.find((x) => x.name === "fleet_rollout")!;
    const evil = p.build({ clusterId: "c1", action: "rm -rf / ; drop table" });
    expect(evil).not.toContain("rm -rf");
    expect(evil).toContain('"restart"'); // fell back to the allowlisted default
    expect(p.build({ clusterId: "c1", action: "stop" })).toContain('"stop"'); // a valid action is kept
  });

  it("build() never throws when optional args are absent", () => {
    for (const p of MCP_PROMPTS) {
      const onlyRequired = Object.fromEntries(p.arguments.filter((a) => a.required).map((a) => [a.name, "x"]));
      expect(() => p.build(onlyRequired)).not.toThrow();
    }
  });
});
