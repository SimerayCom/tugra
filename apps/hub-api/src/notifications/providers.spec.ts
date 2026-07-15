jest.mock("./safe-url");

import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import { safeSend } from "./safe-url";
import { getProvider } from "./providers";
import { levelColorHex, levelColorInt, levelPriorityGotify, levelPriorityPushover, levelTag, type RenderedMessage } from "./rendered-message";

const mockSend = safeSend as jest.Mock;

const RM = (over: Partial<RenderedMessage> = {}): RenderedMessage => ({
  level: "failure",
  title: "Deploy failed",
  summary: "app blog failed to deploy",
  fields: [
    { label: "Project", value: "web" },
    { label: "Env", value: "prod", inline: true },
  ],
  links: [{ label: "Logs", url: "https://hub/logs" }],
  critical: false,
  timestamp: "2026-01-01T00:00:00.000Z",
  event: "deploy_failed",
  ...over,
});

// safeSend(url, body, headers, opts) — read the captured call.
const args = () => mockSend.mock.calls[0];
const sentUrl = () => args()[0] as string;
const sentBody = () => args()[1] as string;
const sentJson = () => JSON.parse(sentBody());
const sentHeaders = () => args()[2] as Record<string, string>;

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(undefined);
});

describe("notification providers — rich rendering over the SSRF-guarded transport", () => {
  afterEach(() => jest.restoreAllMocks());

  it("routes through safeSend, not raw fetch", async () => {
    await getProvider("discord").send({ webhookUrl: "https://d" }, RM());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("discord renders a colored embed with mapped fields + link; no @here when not critical", async () => {
    await getProvider("discord").send({ webhookUrl: "https://d" }, RM());
    const b = sentJson();
    expect(b.embeds[0].color).toBe(levelColorInt("failure"));
    expect(b.embeds[0].fields).toEqual([
      { name: "Project", value: "web", inline: false },
      { name: "Env", value: "prod", inline: true },
    ]);
    expect(b.embeds[0].footer.text).toBe("Tugra");
    expect(b.embeds[0].description).toContain("[Logs](https://hub/logs)");
    expect(b.content).toBeUndefined();
    expect(sentHeaders()["content-type"]).toBe("application/json");
  });

  it("discord adds content:@here when critical", async () => {
    await getProvider("discord").send({ webhookUrl: "https://d" }, RM({ critical: true }));
    expect(sentJson().content).toBe("@here");
  });

  it("slack renders a colored attachment with short fields + link", async () => {
    await getProvider("slack").send({ webhookUrl: "https://s" }, RM());
    const a = sentJson().attachments[0];
    expect(a.color).toBe(levelColorHex("failure"));
    expect(a.pretext).toBe("Deploy failed");
    expect(a.fields).toEqual([
      { title: "Project", value: "web", short: false },
      { title: "Env", value: "prod", short: true },
    ]);
    expect(a.text).toContain("<https://hub/logs|Logs>");
    expect(a.mrkdwn_in).toContain("fields");
  });

  it("telegram sends HTML + inline-keyboard buttons + thread id", async () => {
    await getProvider("telegram").send({ botToken: "T", chatId: "1", messageThreadId: "42" }, RM());
    expect(sentUrl()).toContain("api.telegram.org/botT");
    const b = sentJson();
    expect(b.parse_mode).toBe("HTML");
    expect(b.disable_web_page_preview).toBe(true);
    expect(b.text).toContain("<b>Deploy failed</b>");
    expect(b.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Logs", url: "https://hub/logs" });
    expect(b.message_thread_id).toBe(42);
  });

  it("telegram HTML-escapes field values and omits reply_markup with no links", async () => {
    await getProvider("telegram").send({ botToken: "T", chatId: "1" }, RM({ links: [], fields: [{ label: "x", value: "<script>" }] }));
    const b = sentJson();
    expect(b.text).toContain("&lt;script&gt;");
    expect(b.text).not.toContain("<script>");
    expect(b.reply_markup).toBeUndefined();
  });

  it("ntfy sets X-Title/X-Priority/X-Tags/X-Actions + bearer, priority override wins", async () => {
    await getProvider("ntfy").send({ topic: "alerts", accessToken: "tok", priority: 9 }, RM());
    const h = sentHeaders();
    expect(h["X-Tags"]).toBe(levelTag("failure"));
    expect(h["X-Priority"]).toBe("9"); // config override beats the level default
    expect(h["X-Title"]).toBe("Deploy failed");
    expect(h["X-Actions"]).toContain("view, Logs, https://hub/logs");
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(sentUrl()).toBe("https://ntfy.sh/alerts");
  });

  it("ntfy X-Actions neutralizes a crafted link label/url (no header or action injection)", async () => {
    await getProvider("ntfy").send({ topic: "t" }, RM({ links: [{ label: "ev,il;x\ny", url: "http://a\nb" }] }));
    const actions = sentHeaders()["X-Actions"];
    expect(actions).not.toMatch(/[\r\n]/);
    expect(actions).not.toContain("ev,il");
    expect(actions).not.toContain("a\nb");
  });

  it("ntfy strips a non-ASCII title from the header but keeps it (lossless) in the body", async () => {
    await getProvider("ntfy").send({ topic: "t" }, RM({ title: "Tuğra ✅ deploy", links: [] }));
    expect(sentHeaders()["X-Title"]).not.toMatch(/[^\x20-\x7e]/);
    expect(sentBody()).toContain("Tuğra ✅ deploy");
  });

  it("gotify sends a level-mapped priority + dynamic title", async () => {
    await getProvider("gotify").send({ server: "https://g", token: "K" }, RM());
    const b = sentJson();
    expect(b.priority).toBe(levelPriorityGotify("failure"));
    expect(b.title).toBe("Deploy failed");
    expect(sentUrl()).toBe("https://g/message?token=K");
  });

  it("smtp sends a dynamic subject + escaped HTML + plain text; guards CRLF header injection", async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    jest.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    await getProvider("smtp").send(
      { host: "mail", to: "a@b.c" },
      RM({ title: "Deploy failed\r\nBcc: evil@x", fields: [{ label: "F", value: "<script>alert(1)</script>" }] }),
    );
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).toContain("<h2>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).not.toContain("<script>alert");
    expect(typeof mail.text).toBe("string");
  });

  describe("webhook — structured payload + HMAC + custom headers", () => {
    it("posts a structured versioned payload", async () => {
      await getProvider("webhook").send({ url: "https://hook.test/x" }, RM());
      expect(sentUrl()).toBe("https://hook.test/x");
      const b = sentJson();
      expect(b).toMatchObject({
        version: 1,
        event: "deploy_failed",
        level: "failure",
        title: "Deploy failed",
        summary: "app blog failed to deploy",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(b.fields).toHaveLength(2);
      expect(b.links[0]).toEqual({ label: "Logs", url: "https://hub/logs" });
      expect(sentHeaders()["content-type"]).toBe("application/json");
    });

    it("adds no signature header when signingSecret is absent (backward-compat)", async () => {
      await getProvider("webhook").send({ url: "https://hook.test/x" }, RM());
      expect(sentHeaders()["X-Tugra-Signature"]).toBeUndefined();
    });

    it("signs the EXACT body bytes with X-Tugra-Signature: sha256=<hmac>", async () => {
      const secret = "a-super-secret-signing-key";
      await getProvider("webhook").send({ url: "https://hook.test/x", signingSecret: secret }, RM());
      const expected = "sha256=" + createHmac("sha256", secret).update(sentBody()).digest("hex");
      expect(sentHeaders()["X-Tugra-Signature"]).toBe(expected);
    });

    it("merges custom headers", async () => {
      await getProvider("webhook").send({ url: "https://hook.test/x", headers: { "X-Foo": "bar" } }, RM());
      expect(sentHeaders()["X-Foo"]).toBe("bar");
    });

    it("never lets a custom header override content-type or the signature", async () => {
      const secret = "a-super-secret-signing-key";
      await getProvider("webhook").send(
        { url: "https://hook.test/x", signingSecret: secret, headers: { "Content-Type": "text/plain", "X-Tugra-Signature": "sha256=deadbeef" } },
        RM(),
      );
      const h = sentHeaders();
      expect(h["content-type"]).toBe("application/json");
      expect(h["X-Tugra-Signature"]).toBe("sha256=" + createHmac("sha256", secret).update(sentBody()).digest("hex"));
      expect(h["X-Tugra-Signature"]).not.toBe("sha256=deadbeef");
    });

    it("drops a custom header whose value contains CRLF (injection guard)", async () => {
      await getProvider("webhook").send({ url: "https://hook.test/x", headers: { "X-Evil": "a\r\nX-Injected: 1" } }, RM());
      expect(sentHeaders()["X-Evil"]).toBeUndefined();
    });

    it("drops framing/hop-by-hop headers (Content-Length/Transfer-Encoding/Connection/Host → no request smuggling)", async () => {
      await getProvider("webhook").send(
        { url: "https://hook.test/x", headers: { "Content-Length": "5", "Transfer-Encoding": "chunked", Connection: "close", Host: "evil" } },
        RM(),
      );
      const h = sentHeaders();
      for (const k of Object.keys(h)) expect(k.toLowerCase()).not.toBe("content-length");
      for (const k of Object.keys(h)) expect(k.toLowerCase()).not.toBe("transfer-encoding");
      for (const k of Object.keys(h)) expect(k.toLowerCase()).not.toBe("connection");
      expect(h.Host).toBeUndefined();
    });
  });

  describe("pushover", () => {
    it("maps title/message/user + level priority + first link, no emergency by default", async () => {
      await getProvider("pushover").send({ token: "app", userKey: "usr" }, RM());
      expect(sentUrl()).toBe("https://api.pushover.net/1/messages.json");
      const b = sentJson();
      expect(b.token).toBe("app");
      expect(b.user).toBe("usr");
      expect(b.title).toBe("Deploy failed");
      expect(b.message).toContain("Project: web");
      expect(b.priority).toBe(levelPriorityPushover("failure"));
      expect(b.url).toBe("https://hub/logs");
      expect(b.url_title).toBe("Logs");
      expect(b.retry).toBeUndefined();
      expect(b.expire).toBeUndefined();
    });

    it("critical → priority 1; omits url when no links", async () => {
      await getProvider("pushover").send({ token: "app", userKey: "usr" }, RM({ critical: true, links: [] }));
      const b = sentJson();
      expect(b.priority).toBe(1);
      expect(b.url).toBeUndefined();
      expect(b.url_title).toBeUndefined();
    });

    it("config priority override wins and is clamped to [-2,2]", async () => {
      await getProvider("pushover").send({ priority: "-2" }, RM());
      expect(sentJson().priority).toBe(-2);
      mockSend.mockClear();
      await getProvider("pushover").send({ priority: "5" }, RM());
      expect(sentJson().priority).toBe(2);
    });

    it("emergency (priority 2) adds retry/expire with floors/caps", async () => {
      await getProvider("pushover").send({ priority: "2" }, RM());
      expect(sentJson()).toMatchObject({ priority: 2, retry: 60, expire: 3600 });
      mockSend.mockClear();
      await getProvider("pushover").send({ priority: "2", retry: "10", expire: "99999" }, RM());
      expect(sentJson()).toMatchObject({ retry: 30, expire: 10800 }); // floored / capped
      mockSend.mockClear();
      // expire must stay positive — a bad "0"/negative would 400 and silently drop the alert
      await getProvider("pushover").send({ priority: "2", expire: "0" }, RM());
      expect(sentJson().expire).toBe(1);
      mockSend.mockClear();
      await getProvider("pushover").send({ priority: "2", expire: "-5" }, RM());
      expect(sentJson().expire).toBe(1);
    });

    it("an empty-string priority reads as UNSET (not 0)", async () => {
      await getProvider("pushover").send({ priority: "" }, RM()); // failure level
      expect(sentJson().priority).toBe(levelPriorityPushover("failure")); // 1, not 0
    });

    it("clamps an over-long message to 1024 chars", async () => {
      await getProvider("pushover").send({}, RM({ summary: "x".repeat(2000), fields: [] }));
      expect(sentJson().message.length).toBe(1024);
    });
  });

  describe("teams", () => {
    it("renders an adaptive card with a colored title, FactSet, and root actions", async () => {
      await getProvider("teams").send({ webhookUrl: "https://t" }, RM());
      const b = sentJson();
      expect(b.type).toBe("message");
      expect(b.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
      const c = b.attachments[0].content;
      expect(c.type).toBe("AdaptiveCard");
      expect(c.body[0]).toMatchObject({ type: "TextBlock", weight: "Bolder", size: "Large", color: "attention", text: "Deploy failed" });
      const factSet = c.body.find((x: { type: string }) => x.type === "FactSet");
      expect(factSet.facts).toEqual([
        { title: "Project", value: "web" },
        { title: "Env", value: "prod" },
      ]);
      expect(c.actions).toEqual([{ type: "Action.OpenUrl", title: "Logs", url: "https://hub/logs" }]);
    });

    it("omits FactSet when no fields and actions when no links", async () => {
      await getProvider("teams").send({ webhookUrl: "https://t" }, RM({ fields: [], links: [] }));
      const c = sentJson().attachments[0].content;
      expect(c.body.some((x: { type: string }) => x.type === "FactSet")).toBe(false);
      expect(c.actions).toBeUndefined();
    });
  });

  describe("mattermost", () => {
    it("renders a Slack-compatible attachment WITHOUT a top-level text (no double title)", async () => {
      await getProvider("mattermost").send({ webhookUrl: "https://m" }, RM());
      const b = sentJson();
      expect(b.text).toBeUndefined(); // guards the double-title regression
      const a = b.attachments[0];
      expect(a.color).toBe(levelColorHex("failure"));
      expect(a.pretext).toBe("Deploy failed");
      expect(a.fields).toEqual([
        { title: "Project", value: "web", short: false },
        { title: "Env", value: "prod", short: true },
      ]);
      expect(a.text).toContain("<https://hub/logs|Logs>");
    });
  });

  describe("lark", () => {
    it("renders an interactive card with a templated header + button action", async () => {
      await getProvider("lark").send({ webhookUrl: "https://l" }, RM());
      const b = sentJson();
      expect(b.msg_type).toBe("interactive");
      expect(b.card.header.template).toBe("red"); // failure
      expect(b.card.header.title.content).toBe("Deploy failed");
      expect(b.card.elements[0]).toMatchObject({ tag: "div", text: { tag: "lark_md" } });
      expect(b.card.elements[0].text.content).toContain("Project: web");
      expect(b.card.elements[1]).toMatchObject({
        tag: "action",
        actions: [{ tag: "button", text: { tag: "plain_text", content: "Logs" }, url: "https://hub/logs", type: "default" }],
      });
    });

    it("omits the action element when there are no links", async () => {
      await getProvider("lark").send({ webhookUrl: "https://l" }, RM({ links: [] }));
      expect(sentJson().card.elements).toHaveLength(1);
    });
  });

  describe("resend", () => {
    it("POSTs to the Resend email API with a Bearer key, comma-split recipients, and escaped html", async () => {
      await getProvider("resend").send(
        { apiKey: "re_x", from: "a@b.c", to: "a@b.c, d@e.f" },
        RM({ fields: [{ label: "F", value: "<script>alert(1)</script>" }] }),
      );
      expect(sentUrl()).toBe("https://api.resend.com/emails");
      const h = sentHeaders();
      expect(h.authorization).toBe("Bearer re_x");
      expect(h["content-type"]).toBe("application/json");
      const b = sentJson();
      expect(b.from).toBe("a@b.c");
      expect(b.to).toEqual(["a@b.c", "d@e.f"]);
      expect(b.subject).not.toMatch(/[\r\n]/);
      expect(b.html).toContain("<h2>");
      expect(b.html).toContain("&lt;script&gt;");
      expect(b.html).not.toContain("<script>alert");
      expect(typeof b.text).toBe("string");
    });

    it("sanitizes a CRLF-laced api key out of the Authorization header", async () => {
      await getProvider("resend").send({ apiKey: "re_x\r\nX-Evil: 1", from: "a@b.c", to: "a@b.c" }, RM());
      const auth = sentHeaders().authorization;
      expect(auth).not.toMatch(/[\r\n]/);
      expect(auth.startsWith("Bearer ")).toBe(true);
    });
  });

  it("throws on an unknown channel type", () => {
    expect(() => getProvider("nope")).toThrow(/unknown channel type/);
  });
});
