import { AGENT_CAPABILITIES } from "@tugra/shared";
import { NetworkSettingsSchema, SetCapabilitiesSchema } from "./servers.schemas";

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

describe("NetworkSettingsSchema dnsCreds", () => {
  it("accepts single-line credentials, including a token pasted with a trailing newline (trimmed by the service)", () => {
    expect(NetworkSettingsSchema.safeParse({ dnsCreds: { CF_DNS_API_TOKEN: "tok" } }).success).toBe(true);
    expect(NetworkSettingsSchema.safeParse({ dnsCreds: { CF_DNS_API_TOKEN: "tok\n" } }).success).toBe(true);
    expect(NetworkSettingsSchema.safeParse({ dnsCreds: null }).success).toBe(true);
  });
  it("rejects a line break or NUL inside a value and an invalid name, naming the key not the value", () => {
    for (const v of ["a\nb", "a\r\nb", "a\u0000b"]) {
      const r = NetworkSettingsSchema.safeParse({ dnsCreds: { CF_DNS_API_TOKEN: v } });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r)).toContain("CF_DNS_API_TOKEN");
    }
    expect(NetworkSettingsSchema.safeParse({ dnsCreds: { "A=B": "x" } }).success).toBe(false);
    expect(NetworkSettingsSchema.safeParse({ dnsCreds: { "": "x" } }).success).toBe(false);
  });
});
