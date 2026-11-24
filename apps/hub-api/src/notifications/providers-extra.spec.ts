jest.mock("./safe-url");

import { safeRequest, safeSend } from "./safe-url";
import { getProvider, PROVIDER_TYPES } from "./providers";
import type { RenderedMessage } from "./rendered-message";

const mockSend = safeSend as jest.Mock;
const mockReq = safeRequest as jest.Mock;

const RM = (over: Partial<RenderedMessage> = {}): RenderedMessage => ({
  level: "failure",
  title: "Monitor down — Acme",
  summary: "Acme is DOWN.",
  fields: [{ label: "Target", value: "https://example.com" }],
  links: [{ label: "View monitor", url: "https://hub/monitors/m1" }],
  critical: true,
  timestamp: "2026-11-24T00:00:00.000Z",
  event: "monitor_down",
  group: "monitor:m1",
  ...over,
});

const call = (i = 0) => ({ url: mockSend.mock.calls[i][0] as string, body: mockSend.mock.calls[i][1] as string, headers: mockSend.mock.calls[i][2] as Record<string, string> });
const json = (i = 0) => JSON.parse(call(i).body);

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
});

it("registers every new channel type", () => {
  for (const t of ["matrix", "googlechat", "rocketchat", "pagerduty", "opsgenie", "zulip", "bark", "signal", "sms"]) {
    expect(PROVIDER_TYPES).toContain(t);
  }
});

describe("matrix", () => {
  const res = (status: number, body: unknown = {}) => ({ status, body: JSON.stringify(body) });
  const cfg = { homeserver: "https://matrix.example.com/", roomId: "!room:example.com", accessToken: "syt_abc" };

  it("PUTs an HTML message to the room with the access token", async () => {
    mockReq.mockResolvedValue(res(200));
    await getProvider("matrix").send(cfg, RM());
    const [url, body, headers, opts] = mockReq.mock.calls[0];
    expect(url).toMatch(/^https:\/\/matrix\.example\.com\/_matrix\/client\/v3\/rooms\/!room%3Aexample\.com\/send\/m\.room\.message\/[0-9a-f-]{36}$/);
    expect(opts.method).toBe("PUT");
    expect(headers.authorization).toBe("Bearer syt_abc");
    const b = JSON.parse(body);
    expect(b).toMatchObject({ msgtype: "m.text", format: "org.matrix.custom.html" });
    expect(b.formatted_body).toContain("<b>Monitor down — Acme</b>");
    expect(b.body).toContain("View monitor: https://hub/monitors/m1");
  });

  it("escapes HTML in the formatted body", async () => {
    mockReq.mockResolvedValue(res(200));
    await getProvider("matrix").send(cfg, RM({ title: "<script>x</script>" }));
    expect(JSON.parse(mockReq.mock.calls[0][1]).formatted_body).not.toContain("<script>");
  });

  it("signs in with a password, joins an alias, then sends; a 401 re-logs in once", async () => {
    mockReq
      .mockResolvedValueOnce(res(200, { access_token: "tok1" })) // login
      .mockResolvedValueOnce(res(200, { room_id: "!joined:example.com" })) // join
      .mockResolvedValueOnce(res(401)) // send rejected
      .mockResolvedValueOnce(res(200, { access_token: "tok2" })) // re-login
      .mockResolvedValueOnce(res(200, { room_id: "!joined:example.com" })) // join again (new token → new cache key)
      .mockResolvedValueOnce(res(200)); // send ok
    await getProvider("matrix").send({ homeserver: "https://m.example.com", roomId: "#ops:example.com", user: "bot", password: "pw-one" }, RM());
    const urls = mockReq.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe("https://m.example.com/_matrix/client/v3/login");
    expect(urls[1]).toContain("/join/%23ops%3Aexample.com");
    expect(mockReq.mock.calls[5][3].method).toBe("PUT");
    expect(mockReq.mock.calls[5][2].authorization).toBe("Bearer tok2");
  });

  it("fails with the status only (no body) when the send is refused", async () => {
    mockReq.mockResolvedValue({ status: 403, body: "secret-ish body" });
    await expect(getProvider("matrix").send(cfg, RM())).rejects.toThrow("matrix: HTTP 403");
  });
});

describe("googlechat / rocketchat", () => {
  it("google chat sends a cardsV2 card with an open-link button", async () => {
    await getProvider("googlechat").send({ webhookUrl: "https://chat.googleapis.com/v1/spaces/A/messages?key=k&token=t" }, RM());
    const b = json();
    expect(b.cardsV2[0].card.header.title).toBe("Monitor down — Acme");
    const widgets = b.cardsV2[0].card.sections[0].widgets;
    expect(widgets.at(-1).buttonList.buttons[0].onClick.openLink.url).toBe("https://hub/monitors/m1");
  });
  it("rocket.chat sends a Slack-style attachment", async () => {
    await getProvider("rocketchat").send({ webhookUrl: "https://chat.example.com/hooks/a/b" }, RM());
    expect(json().attachments[0]).toMatchObject({ title: "Monitor down — Acme", color: expect.stringMatching(/^#/) });
  });
});

describe("pagerduty", () => {
  it("a failure triggers an incident keyed by the alert's group", async () => {
    await getProvider("pagerduty").send({ routingKey: "R123" }, RM());
    expect(call().url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(json()).toMatchObject({
      routing_key: "R123",
      event_action: "trigger",
      dedup_key: "tugra:monitor:m1",
      payload: { severity: "critical", source: "tugra", custom_details: { Target: "https://example.com" } },
      links: [{ href: "https://hub/monitors/m1", text: "View monitor" }],
    });
  });
  it("a recovery resolves the same incident; good news without a key sends nothing", async () => {
    await getProvider("pagerduty").send({ routingKey: "R123", region: "eu" }, RM({ level: "success", critical: false, event: "monitor_up" }));
    expect(call().url).toBe("https://events.eu.pagerduty.com/v2/enqueue");
    expect(json()).toEqual({ routing_key: "R123", event_action: "resolve", dedup_key: "tugra:monitor:m1" });
    mockSend.mockClear();
    await getProvider("pagerduty").send({ routingKey: "R123" }, RM({ level: "success", group: undefined }));
    expect(mockSend).not.toHaveBeenCalled();
  });
  it("a warning is not critical", async () => {
    await getProvider("pagerduty").send({ routingKey: "R123" }, RM({ level: "warning", critical: false }));
    expect(json().payload.severity).toBe("warning");
  });
});

describe("opsgenie", () => {
  it("opens an alert with a GenieKey header, alias and priority", async () => {
    await getProvider("opsgenie").send({ apiKey: "key-1" }, RM());
    expect(call().url).toBe("https://api.opsgenie.com/v2/alerts");
    expect(call().headers.authorization).toBe("GenieKey key-1");
    expect(json()).toMatchObject({ message: "Monitor down — Acme", alias: "tugra:monitor:m1", priority: "P1", source: "Tugra" });
  });
  it("closes the alert on recovery, on the EU host when asked", async () => {
    await getProvider("opsgenie").send({ apiKey: "key-1", region: "eu" }, RM({ level: "success", critical: false }));
    expect(call().url).toBe("https://api.eu.opsgenie.com/v2/alerts/tugra%3Amonitor%3Am1/close?identifierType=alias");
  });
  it("trims the message to Opsgenie's 130 characters", async () => {
    await getProvider("opsgenie").send({ apiKey: "k" }, RM({ title: "x".repeat(300) }));
    expect(json().message).toHaveLength(130);
  });
});

describe("zulip / bark / signal / sms", () => {
  it("zulip posts a markdown stream message with basic auth", async () => {
    await getProvider("zulip").send({ server: "https://chat.example.com/", email: "bot@chat.example.com", apiKey: "k", stream: "ops", topic: "alerts" }, RM());
    expect(call().url).toBe("https://chat.example.com/api/v1/messages");
    expect(call().headers.authorization).toBe(`Basic ${Buffer.from("bot@chat.example.com:k").toString("base64")}`);
    const p = new URLSearchParams(call().body);
    expect(p.get("to")).toBe("ops");
    expect(p.get("topic")).toBe("alerts");
    expect(p.get("content")).toContain("**Monitor down — Acme**");
  });
  it("bark pushes with a time-sensitive level, or critical for a critical event", async () => {
    await getProvider("bark").send({ deviceKey: "dev1" }, RM({ critical: false }));
    expect(call().url).toBe("https://api.day.app/push");
    expect(json()).toMatchObject({ device_key: "dev1", level: "timeSensitive", url: "https://hub/monitors/m1" });
    mockSend.mockClear();
    await getProvider("bark").send({ deviceKey: "dev1" }, RM({ critical: true }));
    expect(json().level).toBe("critical");
  });
  it("signal sends to every recipient in one call", async () => {
    await getProvider("signal").send({ server: "http://signal:8080", number: "+15551230000", recipients: "+15559870000, +15559870001" }, RM());
    expect(call().url).toBe("http://signal:8080/v2/send");
    expect(json()).toMatchObject({ number: "+15551230000", recipients: ["+15559870000", "+15559870001"] });
  });
  it("sms posts one short Twilio message with basic auth", async () => {
    const sid = "AC" + "b".repeat(32);
    await getProvider("sms").send({ accountSid: sid, authToken: "tok", from: "+15551230000", to: "+15559870000" }, RM());
    expect(call().url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    expect(call().headers.authorization).toBe(`Basic ${Buffer.from(`${sid}:tok`).toString("base64")}`);
    const p = new URLSearchParams(call().body);
    expect(p.get("To")).toBe("+15559870000");
    expect(p.get("From")).toBe("+15551230000");
    expect(p.get("Body")!.length).toBeLessThanOrEqual(320);
  });
  it("sms uses a messaging service when from is an MG sid", async () => {
    const mg = "MG" + "c".repeat(32);
    await getProvider("sms").send({ accountSid: "AC" + "b".repeat(32), authToken: "tok", from: mg, to: "+15559870000" }, RM());
    const p = new URLSearchParams(call().body);
    expect(p.get("MessagingServiceSid")).toBe(mg);
    expect(p.has("From")).toBe(false);
  });
});

describe("ntfy basic auth", () => {
  it("sends Basic credentials when a username is configured", async () => {
    await getProvider("ntfy").send({ server: "https://ntfy.example.com", topic: "t", username: "me", password: "pw" }, RM());
    expect(call().headers.Authorization).toBe(`Basic ${Buffer.from("me:pw").toString("base64")}`);
  });
});
