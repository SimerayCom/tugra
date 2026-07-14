import nodemailer from "nodemailer";
import { getProvider } from "./providers";
import { levelColorHex, levelColorInt, levelPriorityGotify, levelTag, type RenderedMessage } from "./rendered-message";

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

const okFetch = () => jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response);
const jsonBody = (f: jest.SpyInstance) => JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
const rawBody = (f: jest.SpyInstance) => (f.mock.calls[0][1] as RequestInit).body as string;
const headersOf = (f: jest.SpyInstance) => (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;

describe("notification providers — rich rendering", () => {
  afterEach(() => jest.restoreAllMocks());

  it("discord renders a colored embed with mapped fields + link; no @here when not critical", async () => {
    const f = okFetch();
    await getProvider("discord").send({ webhookUrl: "http://d" }, RM());
    const b = jsonBody(f);
    expect(b.embeds[0].color).toBe(levelColorInt("failure"));
    expect(b.embeds[0].fields).toEqual([
      { name: "Project", value: "web", inline: false },
      { name: "Env", value: "prod", inline: true },
    ]);
    expect(b.embeds[0].footer.text).toBe("Tugra");
    expect(b.embeds[0].description).toContain("[Logs](https://hub/logs)");
    expect(b.content).toBeUndefined();
  });

  it("discord adds content:@here when critical", async () => {
    const f = okFetch();
    await getProvider("discord").send({ webhookUrl: "http://d" }, RM({ critical: true }));
    expect(jsonBody(f).content).toBe("@here");
  });

  it("slack renders a colored attachment with short fields + link", async () => {
    const f = okFetch();
    await getProvider("slack").send({ webhookUrl: "http://s" }, RM());
    const a = jsonBody(f).attachments[0];
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
    const f = okFetch();
    await getProvider("telegram").send({ botToken: "T", chatId: "1", messageThreadId: "42" }, RM());
    expect(String(f.mock.calls[0][0])).toContain("api.telegram.org/botT");
    const b = jsonBody(f);
    expect(b.parse_mode).toBe("HTML");
    expect(b.disable_web_page_preview).toBe(true);
    expect(b.text).toContain("<b>Deploy failed</b>");
    expect(b.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Logs", url: "https://hub/logs" });
    expect(b.message_thread_id).toBe(42);
  });

  it("telegram HTML-escapes field values and omits reply_markup with no links", async () => {
    const f = okFetch();
    await getProvider("telegram").send({ botToken: "T", chatId: "1" }, RM({ links: [], fields: [{ label: "x", value: "<script>" }] }));
    const b = jsonBody(f);
    expect(b.text).toContain("&lt;script&gt;");
    expect(b.text).not.toContain("<script>");
    expect(b.reply_markup).toBeUndefined();
  });

  it("ntfy sets X-Title/X-Priority/X-Tags/X-Actions + bearer, priority override wins", async () => {
    const f = okFetch();
    await getProvider("ntfy").send({ topic: "alerts", accessToken: "tok", priority: 9 }, RM());
    const h = headersOf(f);
    expect(h["X-Tags"]).toBe(levelTag("failure"));
    expect(h["X-Priority"]).toBe("9"); // config override beats the level default
    expect(h["X-Title"]).toBe("Deploy failed");
    expect(h["X-Actions"]).toContain("view, Logs, https://hub/logs");
    expect(h["Authorization"]).toBe("Bearer tok");
  });

  it("ntfy X-Actions neutralizes a crafted link label/url (no header or action injection)", async () => {
    const f = okFetch();
    await getProvider("ntfy").send({ topic: "t" }, RM({ links: [{ label: "ev,il;x\ny", url: "http://a\nb" }] }));
    const actions = headersOf(f)["X-Actions"];
    expect(actions).not.toMatch(/[\r\n]/); // newline → no injected header
    expect(actions).not.toContain("ev,il"); // ',' / ';' in the label neutralized (no extra actions)
    expect(actions).not.toContain("a\nb"); // newline stripped from the url
  });

  it("ntfy strips a non-ASCII title from the header but keeps it (lossless) in the body", async () => {
    const f = okFetch();
    await getProvider("ntfy").send({ topic: "t" }, RM({ title: "Tuğra ✅ deploy", links: [] }));
    const h = headersOf(f);
    expect(h["X-Title"]).not.toMatch(/[^\x20-\x7e]/); // header is ASCII-safe
    expect(rawBody(f)).toContain("Tuğra ✅ deploy"); // full title preserved in the body
  });

  it("gotify sends a level-mapped priority + dynamic title", async () => {
    const f = okFetch();
    await getProvider("gotify").send({ server: "http://g", token: "K" }, RM());
    const b = jsonBody(f);
    expect(b.priority).toBe(levelPriorityGotify("failure"));
    expect(b.title).toBe("Deploy failed"); // not the old fixed "Tugra"
  });

  it("smtp sends a dynamic subject + escaped HTML + plain text; guards CRLF header injection", async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    jest.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    await getProvider("smtp").send(
      { host: "mail", to: "a@b.c" },
      RM({ title: "Deploy failed\r\nBcc: evil@x", fields: [{ label: "F", value: "<script>alert(1)</script>" }] }),
    );
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).not.toMatch(/[\r\n]/); // CRLF stripped from the subject
    expect(mail.html).toContain("<h2>");
    expect(mail.html).toContain("&lt;script&gt;"); // field value escaped
    expect(mail.html).not.toContain("<script>alert");
    expect(typeof mail.text).toBe("string");
  });

  it("webhook posts a structured versioned payload", async () => {
    const f = okFetch();
    await getProvider("webhook").send({ url: "http://hook.test/x" }, RM());
    expect(f).toHaveBeenCalledWith("http://hook.test/x", expect.objectContaining({ method: "POST" }));
    const b = jsonBody(f);
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
  });

  it("throws on an unknown channel type", () => {
    expect(() => getProvider("nope")).toThrow(/unknown channel type/);
  });
});
