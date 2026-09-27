import { SetLimitsSchema } from "./dto";

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
