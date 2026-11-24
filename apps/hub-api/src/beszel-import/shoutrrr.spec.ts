import { parseShoutrrr } from "./shoutrrr";

const one = (u: string) => {
  const r = parseShoutrrr(u);
  expect(r).toHaveLength(1);
  return r[0];
};

describe("parseShoutrrr", () => {
  it("maps discord to an incoming-webhook URL and keeps the token out of the label", () => {
    const c = one("discord://tok-en_1@123456789?thread_id=77");
    expect(c.type).toBe("discord");
    expect(c.config).toEqual({ webhookUrl: "https://discord.com/api/webhooks/123456789/tok-en_1?thread_id=77" });
    expect(c.label).not.toContain("tok-en_1");
  });

  it("maps slack webhooks in both documented forms and refuses a bot token", () => {
    expect(one("slack://hook:T0AAA-B0BBB-XXXX@webhook").config).toEqual({ webhookUrl: "https://hooks.slack.com/services/T0AAA/B0BBB/XXXX" });
    expect(one("slack://bot@T0AAA/B0BBB/XXXX").config).toEqual({ webhookUrl: "https://hooks.slack.com/services/T0AAA/B0BBB/XXXX" });
    const bot = one("slack://xoxb:123-456@C0123");
    expect(bot.type).toBeNull();
    expect(bot.reason).toBe("unsupportedBot");
  });

  it("maps telegram, one channel per chat, with an optional thread", () => {
    const r = parseShoutrrr("telegram://110201543:AAHdqTcvCH1vGW@telegram?chats=@ops,-100123:9");
    expect(r).toHaveLength(2);
    expect(r[0].config).toEqual({ botToken: "110201543:AAHdqTcvCH1vGW", chatId: "@ops" });
    expect(r[1].config).toEqual({ botToken: "110201543:AAHdqTcvCH1vGW", chatId: "-100123", messageThreadId: 9 });
    expect(r[0].notes).toContain("multipleChats");
    expect(r[0].label).not.toContain("AAHdq");
  });

  it("rejects telegram without a token or chat", () => {
    expect(parseShoutrrr("telegram://onlytoken@telegram")[0].reason).toBe("invalidUrl");
  });

  it("maps ntfy (and skips basic auth Tugra cannot send)", () => {
    expect(one("ntfy://ntfy.example.com/alerts").config).toEqual({ server: "https://ntfy.example.com", topic: "alerts" });
    expect(one("ntfy://ntfy.example.com:8080/alerts?scheme=http").config).toEqual({ server: "http://ntfy.example.com:8080", topic: "alerts" });
    const auth = one("ntfy://user:pw@ntfy.example.com/alerts");
    expect(auth.type).toBeNull();
    expect(auth.reason).toBe("unsupportedAuth");
  });

  it("maps gotify, pushover, mattermost, lark and teams", () => {
    expect(one("gotify://gotify.example.com/sub/APPTOKEN").config).toEqual({ server: "https://gotify.example.com/sub", token: "APPTOKEN" });
    expect(one("gotify://10.0.0.5:8080/APPTOKEN?disabletls=yes").config).toEqual({ server: "http://10.0.0.5:8080", token: "APPTOKEN" });
    expect(one("pushover://shoutrrr:apitoken@userkey").config).toEqual({ token: "apitoken", userKey: "userkey" });
    expect(one("mattermost://bot@mm.example.com/hooktoken/town").config).toEqual({ webhookUrl: "https://mm.example.com/hooks/hooktoken" });
    expect(one("lark://open.larksuite.com/abc123").config).toEqual({ webhookUrl: "https://open.larksuite.com/open-apis/bot/v2/hook/abc123" });
    expect(one("teams://group-id@tenant-id/alt-id/owner-id?host=acme.webhook.office.com").config).toEqual({
      webhookUrl: "https://acme.webhook.office.com/webhookb2/group-id@tenant-id/IncomingWebhook/alt-id/owner-id",
    });
  });

  it("maps smtp with implicit TLS on 465", () => {
    const c = one("smtp://user%40example.com:pw@smtp.example.com:465/?from=a@example.com&to=b@example.com");
    expect(c.type).toBe("smtp");
    expect(c.config).toEqual({ host: "smtp.example.com", port: 465, secure: true, user: "user@example.com", pass: "pw", from: "a@example.com", to: "b@example.com" });
  });

  it("maps generic to a webhook, keeps custom headers and flags the payload difference", () => {
    const c = one("generic://hooks.example.com/in/xyz?template=json&@X-Key=abc&token=1");
    expect(c.type).toBe("webhook");
    expect(c.config).toEqual({ url: "https://hooks.example.com/in/xyz?token=1", headers: { "X-Key": "abc" } });
    expect(c.notes).toContain("genericPayload");
    expect(one("generic+http://hooks.example.com/x").config).toEqual({ url: "http://hooks.example.com/x" });
    expect(one("generic://h.example.com/x?disabletls=yes").config).toEqual({ url: "http://h.example.com/x" });
  });

  it("reports services it does not carry, and garbage", () => {
    const z = one("zulip://bot:key@zulip.example.com/?stream=a&topic=b");
    expect(z.type).toBeNull();
    expect(z.reason).toBe("unsupportedService");
    expect(z.service).toBe("zulip");
    expect(parseShoutrrr("not a url")[0].reason).toBe("invalidUrl");
  });
});
