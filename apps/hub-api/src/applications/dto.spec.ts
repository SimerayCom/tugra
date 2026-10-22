import { SetConfigMountContentSchema, SetLimitsSchema } from "./dto";

describe("SetLimitsSchema — resource reservations", () => {
  it("accepts a reservation at or below the limit", () => {
    expect(() => SetLimitsSchema.parse({ memoryMb: 512, reserveMemoryMb: 256 })).not.toThrow();
    expect(() => SetLimitsSchema.parse({ cpus: 2, reserveCpus: 1 })).not.toThrow();
  });

  it("rejects a reservation above the limit when both are sent together", () => {
    expect(() => SetLimitsSchema.parse({ memoryMb: 256, reserveMemoryMb: 512 })).toThrow();
    expect(() => SetLimitsSchema.parse({ cpus: 1, reserveCpus: 2 })).toThrow();
  });

  it("accepts a reservation alone (no limit to cross-check against)", () => {
    expect(() => SetLimitsSchema.parse({ reserveMemoryMb: 512 })).not.toThrow();
    expect(() => SetLimitsSchema.parse({ reserveCpus: 4 })).not.toThrow();
  });
});

describe("SetConfigMountContentSchema — content-only mount edit", () => {
  it("accepts {target, content}, including empty content", () => {
    expect(SetConfigMountContentSchema.safeParse({ target: "/etc/redis.conf", content: "" }).success).toBe(true);
    expect(SetConfigMountContentSchema.safeParse({ target: "/etc/redis.conf", content: "appendonly yes\n" }).success).toBe(true);
  });

  it("rejects a NUL byte, oversize content, a missing target, and extra keys (selectors are immutable)", () => {
    expect(SetConfigMountContentSchema.safeParse({ target: "/x", content: "a\0b" }).success).toBe(false);
    expect(SetConfigMountContentSchema.safeParse({ target: "/x", content: "a".repeat(64 * 1024 + 1) }).success).toBe(false);
    expect(SetConfigMountContentSchema.safeParse({ content: "a" }).success).toBe(false);
    // .strict() blocks any attempt to change the server-controlled selectors through this endpoint
    expect(SetConfigMountContentSchema.safeParse({ target: "/x", content: "a", serviceName: "redis" }).success).toBe(false);
    expect(SetConfigMountContentSchema.safeParse({ target: "/x", content: "a", mode: "0600" }).success).toBe(false);
  });
});
