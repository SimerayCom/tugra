import { AGENT_CAPABILITIES } from "@tugra/shared";
import { BulkCapabilitiesSchema, MAX_BULK_CAPABILITY_SERVERS, NetworkSettingsSchema, SetCapabilitiesSchema } from "./servers.schemas";

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

describe("BulkCapabilitiesSchema", () => {
  it("accepts opt-in grants/revokes and defaults the missing side to []", () => {
    const r = BulkCapabilitiesSchema.parse({ serverIds: ["a", "b"], grant: ["terminal", "files"] });
    expect(r).toEqual({ serverIds: ["a", "b"], grant: ["terminal", "files"], revoke: [] });
  });
  it("rejects non-opt-in capabilities, empty requests and oversized batches", () => {
    expect(BulkCapabilitiesSchema.safeParse({ serverIds: ["a"], grant: ["deploy"] }).success).toBe(false);
    expect(BulkCapabilitiesSchema.safeParse({ serverIds: ["a"], grant: [], revoke: [] }).success).toBe(false);
    expect(BulkCapabilitiesSchema.safeParse({ serverIds: [], grant: ["terminal"] }).success).toBe(false);
    const many = Array.from({ length: MAX_BULK_CAPABILITY_SERVERS + 1 }, (_, i) => `s${i}`);
    expect(BulkCapabilitiesSchema.safeParse({ serverIds: many, revoke: ["swarm"] }).success).toBe(false);
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
