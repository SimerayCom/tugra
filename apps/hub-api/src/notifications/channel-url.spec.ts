import { ChannelUrlError, CHANNEL_URL_SCHEMES, parseChannelUrl, previewConfig, splitUrl } from "./channel-url";

const TG = "123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123";

describe("splitUrl", () => {
  it("reads userinfo, host, port, path, query and fragment", () => {
    const s = splitUrl("matrix://user:p%40ss@example.com:8448/a/b?x=1&y=2#room:example.com");
    expect(s).toMatchObject({ scheme: "matrix", user: "user", pass: "p@ss", host: "example.com", port: "8448", path: ["a", "b"], hash: "room:example.com" });
    expect(s.query.get("y")).toBe("2");
  });
  it("keeps a colon-bearing bot token in the authority when there is no @", () => {
    expect(splitUrl(`tgram://${TG}/12345`).authority).toBe(TG);
  });
  it("rejects garbage", () => {
    expect(() => splitUrl("not a url")).toThrow(ChannelUrlError);
    expect(() => splitUrl("tgram://%zz@host")).toThrow(ChannelUrlError);
  });
});

describe("parseChannelUrl", () => {
  it("telegram: Shoutrrr form with ?chats=", () => {
    const r = parseChannelUrl(`telegram://${TG}@telegram?chats=@alerts`);
    expect(r).toMatchObject({ type: "telegram", config: { botToken: TG, chatId: "@alerts" } });
  });
  it("telegram: Apprise tgram:// form with the chat in the path and a topic", () => {
    const r = parseChannelUrl(`tgram://${TG}/-1001234567890?topic=42`);
    expect(r).toMatchObject({ type: "telegram", config: { botToken: TG, chatId: "-1001234567890", messageThreadId: 42 } });
  });
  it("telegram: a topic can ride inline as chat:thread", () => {
    expect(parseChannelUrl(`telegram://${TG}@telegram?chats=-1001234567890:7`).config).toMatchObject({ chatId: "-1001234567890", messageThreadId: 7 });
  });
  it("telegram: one channel takes one chat", () => {
    expect(() => parseChannelUrl(`tgram://${TG}/111/222`)).toThrow(/one target/);
    expect(() => parseChannelUrl(`tgram://${TG}@telegram?chats=@aaaaa,@bbbbb`)).toThrow(/one target/);
  });
  it("telegram: rejects a malformed token or missing chat", () => {
    expect(() => parseChannelUrl("tgram://nope/12345")).toThrow(ChannelUrlError);
    expect(() => parseChannelUrl(`tgram://${TG}@telegram`)).toThrow(/missing/);
  });

  it("discord: both URL orders build the webhook URL", () => {
    expect(parseChannelUrl("discord://abcDEF_ghi-1234567890@123456789012345678").config).toEqual({
      webhookUrl: "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-1234567890",
    });
    expect(parseChannelUrl("discord://123456789012345678/abcDEF_ghi-1234567890").config).toEqual({
      webhookUrl: "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-1234567890",
    });
  });

  it("discord: keeps a thread id", () => {
    expect(parseChannelUrl("discord://abcDEF_ghi-1234567890@123456789012345678?thread_id=555").config).toEqual({
      webhookUrl: "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-1234567890?thread_id=555",
    });
  });

  it("slack: Shoutrrr hook form and Apprise token form", () => {
    const want = { webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXX" };
    expect(parseChannelUrl("slack://hook:T00000000-B00000000-XXXXXXXXXXXX@webhook").config).toEqual(want);
    expect(parseChannelUrl("slack://bot@T00000000/B00000000/XXXXXXXXXXXX").config).toEqual(want);
    expect(() => parseChannelUrl("slack://xoxb:123456789012-1234567890123-abcdefg@C0123")).toThrow(/not supported/);
  });

  it("ntfy: hosted topic, self-hosted host with credentials, and a token", () => {
    expect(parseChannelUrl("ntfy://alerts")).toMatchObject({ type: "ntfy", config: { server: "https://ntfy.sh", topic: "alerts" } });
    expect(parseChannelUrl("ntfy://me:secret@ntfy.example.com:8080/alerts?priority=high").config).toEqual({
      server: "https://ntfy.example.com:8080",
      topic: "alerts",
      priority: 4,
      username: "me",
      password: "secret",
    });
    expect(parseChannelUrl("ntfy://tk_abc123@ntfy.example.com/alerts?scheme=http").config).toMatchObject({
      server: "http://ntfy.example.com",
      accessToken: "tk_abc123",
    });
    expect(parseChannelUrl("ntfys://ntfy.example.com/ops").config).toMatchObject({ server: "https://ntfy.example.com", topic: "ops" });
  });

  it("pushover: Shoutrrr (token as password) and Apprise (user key first) orders", () => {
    const user = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG";
    const tok = "azGDORePK8gMaC0QOYAMyEEuzJnyUi";
    expect(parseChannelUrl(`pushover://shoutrrr:${tok}@${user}/?priority=1`).config).toEqual({ token: tok, userKey: user, priority: 1 });
    expect(parseChannelUrl(`pover://${user}@${tok}`).config).toEqual({ token: tok, userKey: user });
    expect(() => parseChannelUrl(`pushover://shoutrrr:${tok}@${user}/?priority=9`)).toThrow(ChannelUrlError);
  });

  it("matrix: password login, token, alias in the fragment, plain http only when asked", () => {
    expect(parseChannelUrl("matrix://bot:pw@matrix.example.com/?rooms=!abc:example.com").config).toEqual({
      homeserver: "https://matrix.example.com",
      roomId: "!abc:example.com",
      user: "bot",
      password: "pw",
    });
    expect(parseChannelUrl("matrixs://syt_token@matrix.example.com/#ops:example.com").config).toMatchObject({
      accessToken: "syt_token",
      roomId: "#ops:example.com",
    });
    expect(parseChannelUrl("matrix://bot:pw@10.0.0.5:8008/?rooms=!abc:example.com&disableTLS=yes").config).toMatchObject({ homeserver: "http://10.0.0.5:8008" });
    expect(() => parseChannelUrl("matrix://matrix.example.com/#ops:example.com")).toThrow(/user or access token/);
    expect(() => parseChannelUrl("matrix://t@matrix.example.com/?rooms=!a:b.c,!d:e.f")).toThrow(/one target/);
  });

  it("gotify: token is the last path segment, a base path is kept", () => {
    expect(parseChannelUrl("gotify://gotify.example.com/AbCdEfGh12345?priority=7").config).toEqual({
      server: "https://gotify.example.com",
      token: "AbCdEfGh12345",
      priority: 7,
    });
    expect(parseChannelUrl("gotifys://gotify.example.com/sub/AbCdEfGh12345").config).toMatchObject({ server: "https://gotify.example.com/sub" });
  });

  it("bark: key from userinfo (either slot) or path", () => {
    expect(parseChannelUrl("bark://:devkey1234@bark.example.com").config).toMatchObject({ deviceKey: "devkey1234", server: "https://bark.example.com" });
    expect(parseChannelUrl("bark://devkey1234@bark.example.com").config).toMatchObject({ deviceKey: "devkey1234" });
    expect(parseChannelUrl("barks://bark.example.com/devkey1234?group=ops").config).toMatchObject({ deviceKey: "devkey1234", group: "ops" });
  });

  it("zulip: Shoutrrr (bot mail + key) and Apprise (botname@org/token)", () => {
    expect(parseChannelUrl("zulip://bot%40chat.example.com:ABCDEFGH1234@chat.example.com/?stream=ops&topic=alerts").config).toEqual({
      server: "https://chat.example.com",
      email: "bot@chat.example.com",
      apiKey: "ABCDEFGH1234",
      stream: "ops",
      topic: "alerts",
    });
    expect(parseChannelUrl("zulip://deploybot@acme/ABCDEFGH1234?to=ops").config).toMatchObject({
      server: "https://acme.zulipchat.com",
      email: "deploybot-bot@acme.zulipchat.com",
      stream: "ops",
    });
    expect(() => parseChannelUrl("zulip://deploybot@acme/ABCDEFGH1234")).toThrow(/stream/);
  });

  it("opsgenie, pagerduty, google chat, rocket.chat, mattermost", () => {
    const key = "11111111-2222-3333-4444-555555555555";
    expect(parseChannelUrl(`opsgenie://${key}?region=eu`).config).toEqual({ apiKey: key, region: "eu" });
    expect(parseChannelUrl(`opsgenie://api.eu.opsgenie.com/${key}`).config).toEqual({ apiKey: key, region: "eu" });
    expect(parseChannelUrl("pagerduty://R0123456789abcdefghijklmnop@x").config).toEqual({ routingKey: "R0123456789abcdefghijklmnop" });
    expect(parseChannelUrl("gchat://AAAA1234/keyKEY-1/tokTOK_2").config).toEqual({
      webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA1234/messages?key=keyKEY-1&token=tokTOK_2",
    });
    expect(parseChannelUrl("googlechat://chat.googleapis.com/v1/spaces/AAAA1234/messages?key=k1&token=t1").config).toMatchObject({
      webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA1234/messages?key=k1&token=t1",
    });
    expect(() => parseChannelUrl("googlechat://evil.example.com/v1/spaces/AAAA1234/messages?key=k1&token=t1")).toThrow(ChannelUrlError);
    expect(parseChannelUrl("rocketchat://chat.example.com/tokenAAAA/tokenBBBB/general").config).toEqual({
      webhookUrl: "https://chat.example.com/hooks/tokenAAAA/tokenBBBB",
    });
    expect(() => parseChannelUrl("rocket://user:pw@chat.example.com/#general")).toThrow(/not supported/);
    expect(parseChannelUrl("mmost://mm.example.com/hooktoken123/town-square").config).toEqual({ webhookUrl: "https://mm.example.com/hooks/hooktoken123" });
  });

  it("twilio SMS and signal", () => {
    const sid = "AC" + "a".repeat(32);
    expect(parseChannelUrl(`twilio://${sid}:authtoken1234567890@+15551230000/+15559870000`)).toMatchObject({
      type: "sms",
      config: { accountSid: sid, authToken: "authtoken1234567890", from: "+15551230000", to: "+15559870000" },
    });
    expect(() => parseChannelUrl(`twilio://${sid}:authtoken1234567890@+15551230000/+15559870000/+15559870001`)).toThrow(/one target/);
    expect(parseChannelUrl("signal://signal.example.com:8080/+15551230000/+15559870000/group.abc123=").config).toEqual({
      server: "http://signal.example.com:8080",
      number: "+15551230000",
      recipients: "+15559870000,group.abc123=",
    });
    expect(parseChannelUrl("signals://signal.example.com/+15551230000/+15559870000").config).toMatchObject({ server: "https://signal.example.com" });
  });

  it("generic json:// / generic:// become a webhook", () => {
    expect(parseChannelUrl("json://hooks.example.com/in/abc").config).toEqual({ url: "https://hooks.example.com/in/abc" });
    expect(parseChannelUrl("generic://hooks.example.com:9000/x?disableTLS=yes").config).toEqual({ url: "http://hooks.example.com:9000/x" });
  });

  it("recognises pasted vendor webhook URLs", () => {
    expect(parseChannelUrl("https://hooks.slack.com/services/T000/B000/XXXX").type).toBe("slack");
    expect(parseChannelUrl("https://discord.com/api/webhooks/123/abc").type).toBe("discord");
    expect(() => parseChannelUrl("https://example.com/hook")).toThrow(/not supported/);
  });

  it("refuses an unknown scheme, whitespace and oversized input", () => {
    expect(() => parseChannelUrl("gopher://x")).toThrow(/scheme/);
    expect(() => parseChannelUrl("ntfy://a b")).toThrow(ChannelUrlError);
    expect(() => parseChannelUrl("ntfy://" + "a".repeat(3000))).toThrow(ChannelUrlError);
    expect(() => parseChannelUrl("")).toThrow(ChannelUrlError);
  });

  it("never echoes the URL (or its secrets) in an error", () => {
    const secret = "supersecrettoken";
    const urls = [`tgram://${secret}/12345`, `discord://${secret}@notanumber`, `matrix://u:${secret}@h/!a:b.c,!d:e.f`, `pushover://x:${secret}@short`, `unknown://${secret}`];
    for (const u of urls) {
      try {
        parseChannelUrl(u);
        throw new Error("expected a failure");
      } catch (e) {
        expect(e).toBeInstanceOf(ChannelUrlError);
        expect((e as Error).message).not.toContain(secret);
      }
    }
  });

  it("every advertised scheme is handled", () => {
    for (const scheme of CHANNEL_URL_SCHEMES) {
      try {
        parseChannelUrl(`${scheme}://x`);
      } catch (e) {
        expect((e as ChannelUrlError).code).not.toBe("unsupported_scheme");
      }
    }
  });
});

describe("previewConfig", () => {
  it("masks credentials and collapses webhook URLs to their origin", () => {
    const out = previewConfig({
      botToken: TG,
      chatId: "@alerts",
      webhookUrl: "https://discord.com/api/webhooks/1/secret",
      password: "pw",
      server: "https://ntfy.example.com",
      empty: "",
    });
    expect(out).toEqual({ botToken: "••••", chatId: "@alerts", webhookUrl: "https://discord.com", password: "••••", server: "https://ntfy.example.com" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });
});
