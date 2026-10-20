import { AGENT_CAPABILITIES } from "@tugra/shared";
import { SetCapabilitiesSchema } from "./servers.schemas";

describe("SetCapabilitiesSchema", () => {
  it("accepts every capability the hub can grant (no drift vs AGENT_CAPABILITIES)", () => {
    // Guards an earlier bug where "files"/"swarm" were grantable in the service but rejected here.
    const parsed = SetCapabilitiesSchema.parse({ capabilities: [...AGENT_CAPABILITIES] });
    expect(parsed.capabilities).toEqual([...AGENT_CAPABILITIES]);
  });

  it("rejects an unknown capability", () => {
    expect(() => SetCapabilitiesSchema.parse({ capabilities: ["not-a-capability"] })).toThrow();
  });
});
