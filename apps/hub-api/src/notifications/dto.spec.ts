import { CreateChannelSchema, UpdateChannelSchema, EVENT_TYPES } from "./dto";

describe("notification channel schemas — event types", () => {
  const base = { name: "ops", type: "slack", teamId: "t1", config: {} };

  it("accepts backup_failed (regression: it used to 400 → flagship alert was dead)", () => {
    expect(EVENT_TYPES).toContain("backup_failed");
    expect(() => CreateChannelSchema.parse({ ...base, eventTypes: ["backup_failed"] })).not.toThrow();
    expect(() => UpdateChannelSchema.parse({ eventTypes: ["backup_failed"] })).not.toThrow();
  });

  it("still rejects an unknown event type", () => {
    expect(() => CreateChannelSchema.parse({ ...base, eventTypes: ["not_a_real_event"] })).toThrow();
  });
});
