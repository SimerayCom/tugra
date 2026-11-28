import {
  channelName,
  cronFromFrequency,
  mergeTags,
  parseCleanup,
  parseCoolifyChannel,
  parseMembers,
  parseSharedRows,
  parseStorageRows,
  parseTaskRows,
  planChannelGroups,
  providerConfig,
  suggestedRole,
  unmappedEvents,
} from "./coolify-settings-map";

const telegramRow = {
  telegram_enabled: true,
  telegram_token: "bot-token-1",
  telegram_chat_id: "-100123",
  telegram_notifications_deployment_success: true,
  telegram_notifications_deployment_success_thread_id: "11",
  telegram_notifications_deployment_failure: true,
  telegram_notifications_deployment_failure_thread_id: "12",
  telegram_notifications_backup_success: true,
  telegram_notifications_backup_success_thread_id: "11",
  telegram_notifications_server_patch: true,
  telegram_notifications_server_patch_thread_id: "99",
  telegram_notifications_status_change: false,
};

describe("parseCoolifyChannel", () => {
  it("reads a Telegram row: secrets only into config, enabled events with their topic", () => {
    const ch = parseCoolifyChannel("telegram", telegramRow)!;
    expect(ch).toMatchObject({ kind: "telegram", enabled: true, secretsReadable: true, providerType: "telegram" });
    expect(ch.config).toEqual({ botToken: "bot-token-1", chatId: "-100123" });
    expect(ch.events).toEqual([
      { event: "backup_success", threadId: "11" },
      { event: "deployment_failure", threadId: "12" },
      { event: "deployment_success", threadId: "11" },
      { event: "server_patch", threadId: "99" },
    ]);
  });

  it("accepts the row wrapped in data", () => {
    expect(parseCoolifyChannel("discord", { data: { discord_enabled: 1, discord_webhook_url: "https://discord.example.com/api/webhooks/1/x" } })).toMatchObject({ enabled: true, secretsReadable: true });
  });

  it("is not readable when a token without read:sensitive omits the secrets", () => {
    const { telegram_token: _t, telegram_chat_id: _c, ...rest } = telegramRow;
    const ch = parseCoolifyChannel("telegram", rest)!;
    expect(ch.secretsReadable).toBe(false);
    expect(ch.config).toEqual({});
  });

  it("says whether the channel was ever set up: switched on, or holding a credential or a destination", () => {
    expect(parseCoolifyChannel("slack", { slack_enabled: false, slack_webhook_url: null })).toMatchObject({ configured: false, enabled: false });
    expect(parseCoolifyChannel("slack", { slack_enabled: false, slack_webhook_url: "https://hooks.slack.test/x" })).toMatchObject({ configured: true });
    expect(parseCoolifyChannel("telegram", { telegram_enabled: true })).toMatchObject({ configured: true, secretsReadable: false });
    expect(parseCoolifyChannel("email", { smtp_enabled: false, resend_enabled: false, smtp_host: "", use_instance_email_settings: false })).toMatchObject({ configured: false });
    expect(parseCoolifyChannel("email", { smtp_enabled: false, smtp_host: "mail.test" })).toMatchObject({ configured: true });
  });

  it("returns null for an empty body (an older Coolify)", () => {
    expect(parseCoolifyChannel("slack", {})).toBeNull();
    expect(parseCoolifyChannel("slack", null)).toBeNull();
  });

  it("ignores a topic id that is not digits", () => {
    const ch = parseCoolifyChannel("telegram", { ...telegramRow, telegram_notifications_deployment_success_thread_id: "abc; drop" })!;
    expect(ch.events.find((e) => e.event === "deployment_success")).toEqual({ event: "deployment_success" });
  });

  it("maps SMTP email, deriving implicit TLS", () => {
    const ch = parseCoolifyChannel("email", { smtp_enabled: true, smtp_host: "smtp.example.com", smtp_port: 465, smtp_username: "u", smtp_password: "p", smtp_from_address: "a@example.com", smtp_recipients: "x@example.com,y@example.com", smtp_encryption: "tls", smtp_notifications_deployment_failure: true })!;
    expect(ch.providerType).toBe("smtp");
    expect(ch.secretsReadable).toBe(true);
    expect(providerConfig(ch, planChannelGroups(ch)[0])).toEqual({ host: "smtp.example.com", port: 465, secure: true, user: "u", pass: "p", from: "a@example.com", to: "x@example.com,y@example.com" });
  });

  it("prefers Resend when it is on, and flags the instance mail settings as not readable", () => {
    const resend = parseCoolifyChannel("email", { resend_enabled: true, resend_api_key: "re_key", smtp_from_address: "a@example.com", smtp_recipients: "x@example.com" })!;
    expect(resend.providerType).toBe("resend");
    expect(resend.config).toEqual({ apiKey: "re_key", from: "a@example.com", to: "x@example.com" });
    const inst = parseCoolifyChannel("email", { smtp_enabled: true, use_instance_email_settings: true })!;
    expect(inst).toMatchObject({ instanceEmail: true, secretsReadable: false });
  });

  it("maps Pushover and webhook secrets", () => {
    expect(parseCoolifyChannel("pushover", { pushover_enabled: true, pushover_user_key: "uk", pushover_api_token: "at" })!.config).toEqual({ token: "at", userKey: "uk" });
    expect(parseCoolifyChannel("webhook", { webhook_enabled: true, webhook_url: "https://hooks.example.com/x" })!.config).toEqual({ url: "https://hooks.example.com/x" });
  });
});

describe("planChannelGroups / unmappedEvents", () => {
  it("makes one Tugra channel per Telegram topic and maps Coolify events to Tugra events", () => {
    const ch = parseCoolifyChannel("telegram", telegramRow)!;
    const groups = planChannelGroups(ch);
    expect(groups).toEqual([
      { threadId: "11", coolifyEvents: ["backup_success", "deployment_success"], tugraEvents: ["backup_success", "volume_backup_success", "deploy_success"] },
      { threadId: "12", coolifyEvents: ["deployment_failure"], tugraEvents: ["deploy_failed"] },
    ]);
    expect(unmappedEvents(ch)).toEqual(["server_patch"]);
    expect(groups.map((g) => channelName("telegram", g))).toEqual(["Telegram (Coolify) - topic 11", "Telegram (Coolify) - topic 12"]);
  });

  it("puts every event of a non-Telegram channel in one channel, and keeps an empty one", () => {
    const d = parseCoolifyChannel("discord", { discord_enabled: true, discord_webhook_url: "https://discord.example.com/x", discord_notifications_deployment_success: true, discord_notifications_server_unreachable: true })!;
    expect(planChannelGroups(d)).toEqual([{ coolifyEvents: ["deployment_success", "server_unreachable"], tugraEvents: ["deploy_success", "server_offline"] }]);
    const none = parseCoolifyChannel("slack", { slack_enabled: true, slack_webhook_url: "https://slack.example.com/x" })!;
    expect(planChannelGroups(none)).toEqual([{ coolifyEvents: [], tugraEvents: [] }]);
  });

  it("reports an unknown event as not carried instead of mapping it", () => {
    const ch = parseCoolifyChannel("discord", { discord_enabled: true, discord_webhook_url: "https://discord.example.com/x", discord_notifications_brand_new_event: true })!;
    expect(unmappedEvents(ch)).toEqual(["brand_new_event"]);
  });
});

describe("cronFromFrequency", () => {
  it.each([
    ["hourly", "0 * * * *"],
    ["daily", "0 0 * * *"],
    ["@weekly", "0 0 * * 0"],
    ["*/5 * * * *", "*/5 * * * *"],
    ["  0   2  * * 1 ", "0 2 * * 1"],
  ])("%s", (input, out) => expect(cronFromFrequency(input)).toBe(out));
  it.each(["", "every 5 minutes", "61 * * * *", "* * * *"])("rejects %j", (input) => expect(cronFromFrequency(input)).toBeNull());
});

describe("row parsers", () => {
  it("shared variables: prefers real_value, flags locked, skips preview twins", () => {
    const rows = parseSharedRows([{ key: "A", value: "{{x}}", real_value: "1" }, { key: "B", is_shown_once: true }, { key: "C", is_preview: true, value: "z" }, { value: "no key" }], "team");
    expect(rows).toEqual([
      { scope: "team", key: "A", value: "1", locked: false },
      { scope: "team", key: "B", locked: true },
    ]);
  });

  it("storages: identity only (the API has no key or secret to read)", () => {
    expect(parseStorageRows([{ uuid: "s1", name: "Acme backups", type: "S3", endpoint: "https://s3.example.com", bucket: "acme", region: "eu-1", key: "SHOULD-NOT-BE-READ" }, { name: "no uuid" }])).toEqual([
      { ref: "s1", name: "Acme backups", type: "s3", endpoint: "https://s3.example.com", bucket: "acme", region: "eu-1", skipTlsVerification: false },
    ]);
  });

  it("scheduled tasks: keeps command + cadence, drops rows without one, bounds the timeout", () => {
    const rows = parseTaskRows([{ uuid: "t1", name: "Nightly", command: "php artisan x", frequency: "daily", container: "web", timeout: 120, enabled: true }, { uuid: "t2", name: "Empty", command: " ", frequency: "daily" }, { uuid: "t3", name: "Slow", command: "x", frequency: "hourly", timeout: 99999, enabled: false }], { kind: "application", ref: "app-1", name: "Acme web" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ref: "t1", container: "web", timeoutSec: 120, enabled: true, resourceRef: "app-1" });
    expect(rows[1]).toMatchObject({ ref: "t3", enabled: false });
    expect(rows[1].timeoutSec).toBeUndefined();
  });

  it("docker cleanup: frequency required, threshold bounded", () => {
    expect(parseCleanup({ docker_cleanup_frequency: "0 3 * * *", docker_cleanup_threshold: 80, delete_unused_volumes: true }, { ref: "srv", name: "app-1" })).toMatchObject({ frequency: "0 3 * * *", thresholdPct: 80, deleteVolumes: true });
    expect(parseCleanup({}, { ref: "srv", name: "app-1" })).toBeNull();
  });

  it("members: lower-cased, de-duplicated, role from pivot when present", () => {
    expect(parseMembers([{ email: "A@Example.com", name: "Ann" }, { email: "a@example.com" }, { email: "bad" }, { email: "b@example.com", pivot: { role: "Admin" } }])).toEqual([
      { email: "a@example.com", name: "Ann" },
      { email: "b@example.com", name: "b@example.com", role: "admin" },
    ]);
    expect(suggestedRole("owner")).toBe("ADMIN");
    expect(suggestedRole("admin")).toBe("ADMIN");
    expect(suggestedRole("member")).toBe("VIEWER");
    expect(suggestedRole(undefined)).toBe("VIEWER");
  });

  it("tags: unused tags stay listed, resources attach by name", () => {
    expect(mergeTags(["prod", "unused"], [{ kind: "application", ref: "a", name: "A", tags: ["prod"] }])).toEqual([
      { name: "prod", resources: [{ kind: "application", ref: "a", name: "A" }] },
      { name: "unused", resources: [] },
    ]);
  });
});
