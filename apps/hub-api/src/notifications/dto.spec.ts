import { CreateChannelSchema, UpdateChannelSchema, WebhookConfigSchema, EVENT_TYPES } from "./dto";

describe("notification channel schemas — event types", () => {
  const base = { name: "ops", type: "slack", teamId: "t1", config: {} };

  it("accepts backup_failed (regression: it used to 400 → flagship alert was dead)", () => {
    expect(EVENT_TYPES).toContain("backup_failed");
    expect(() => CreateChannelSchema.parse({ ...base, eventTypes: ["backup_failed"] })).not.toThrow();
    expect(() => UpdateChannelSchema.parse({ eventTypes: ["backup_failed"] })).not.toThrow();
  });

  it("accepts the operation-coverage events (backup/server-online/volume-backup/scheduled-task/cleanup)", () => {
    const events = [
      "backup_success", "server_online", "volume_backup_success", "volume_backup_failed",
      "scheduled_task_success", "scheduled_task_failed", "docker_cleanup_success", "docker_cleanup_failed",
    ];
    for (const e of events) {
      expect(EVENT_TYPES).toContain(e);
      expect(() => CreateChannelSchema.parse({ ...base, eventTypes: [e] })).not.toThrow();
    }
    expect(() => CreateChannelSchema.parse({ ...base, eventTypes: events })).not.toThrow();
  });

  it("defaults locale to en on create and accepts an explicit locale", () => {
    expect(CreateChannelSchema.parse(base).locale).toBe("en");
    expect(CreateChannelSchema.parse({ ...base, locale: "tr" }).locale).toBe("tr");
    expect(() => UpdateChannelSchema.parse({ locale: "de" })).not.toThrow();
  });

  it("still rejects an unknown event type", () => {
    expect(() => CreateChannelSchema.parse({ ...base, eventTypes: ["not_a_real_event"] })).toThrow();
  });

  it("rejects the orphan monitor events (they fire via the monitor→channel link, not eventTypes)", () => {
    expect(EVENT_TYPES).not.toContain("monitor_down");
    expect(EVENT_TYPES).not.toContain("monitor_up");
    expect(() => CreateChannelSchema.parse({ ...base, eventTypes: ["monitor_down"] })).toThrow();
    expect(() => CreateChannelSchema.parse({ ...base, eventTypes: ["monitor_up"] })).toThrow();
  });
});

describe("WebhookConfigSchema", () => {
  it("accepts a url with an optional signing secret and custom headers", () => {
    expect(
      WebhookConfigSchema.safeParse({
        url: "https://hook.test/x",
        signingSecret: "a-super-secret-16+",
        headers: { "X-Foo": "bar", Authorization: "Bearer abc" },
      }).success,
    ).toBe(true);
  });

  it("requires a valid url", () => {
    expect(WebhookConfigSchema.safeParse({ url: "not-a-url" }).success).toBe(false);
  });

  it("rejects a signing secret shorter than 16 chars", () => {
    expect(WebhookConfigSchema.safeParse({ url: "https://hook.test/x", signingSecret: "short" }).success).toBe(false);
  });

  it("rejects a reserved header key (content-type / x-tugra-signature, case-insensitive)", () => {
    expect(WebhookConfigSchema.safeParse({ url: "https://hook.test/x", headers: { "Content-Type": "text/x" } }).success).toBe(false);
    expect(WebhookConfigSchema.safeParse({ url: "https://hook.test/x", headers: { "X-Tugra-Signature": "x" } }).success).toBe(false);
  });

  it("rejects request-framing / hop-by-hop headers (smuggling guard)", () => {
    for (const k of ["Content-Length", "Transfer-Encoding", "Connection", "Host"]) {
      expect(WebhookConfigSchema.safeParse({ url: "https://hook.test/x", headers: { [k]: "5" } }).success).toBe(false);
    }
  });

  it("rejects a header value containing CR/LF", () => {
    expect(WebhookConfigSchema.safeParse({ url: "https://hook.test/x", headers: { "X-Evil": "a\r\nX-I: 1" } }).success).toBe(false);
  });
});
