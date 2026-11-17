import { RebootRequestSchema } from "./dto";

describe("RebootRequestSchema", () => {
  it("an immediate reboot needs the mode and the typed confirmation, and no `at`", () => {
    expect(RebootRequestSchema.safeParse({ mode: "now", confirmName: "prod-1" }).success).toBe(true);
    expect(RebootRequestSchema.safeParse({ mode: "now" }).success).toBe(false);
    expect(RebootRequestSchema.safeParse({ mode: "now", confirmName: "" }).success).toBe(false);
    expect(RebootRequestSchema.safeParse({ mode: "now", confirmName: "x", at: "2026-12-01T10:00:00Z" }).success).toBe(false);
  });

  it("a scheduled reboot needs an ISO `at` (UTC or with an offset)", () => {
    expect(RebootRequestSchema.safeParse({ mode: "scheduled", confirmName: "x", at: "2026-12-01T10:00:00Z" }).success).toBe(true);
    expect(RebootRequestSchema.safeParse({ mode: "scheduled", confirmName: "x", at: "2026-12-01T13:00:00+03:00" }).success).toBe(true);
    expect(RebootRequestSchema.safeParse({ mode: "scheduled", confirmName: "x" }).success).toBe(false);
    expect(RebootRequestSchema.safeParse({ mode: "scheduled", confirmName: "x", at: "tomorrow" }).success).toBe(false);
    expect(RebootRequestSchema.safeParse({ mode: "scheduled", confirmName: "x", at: "2026-12-01" }).success).toBe(false);
  });

  it("refuses unknown modes and unknown keys", () => {
    expect(RebootRequestSchema.safeParse({ mode: "soon", confirmName: "x" }).success).toBe(false);
    expect(RebootRequestSchema.safeParse({ mode: "now", confirmName: "x", force: true }).success).toBe(false);
  });
});
