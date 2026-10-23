import { agentWsUrl, hubBaseUrl, publicUrlFrom } from "./hub-url";

describe("hub-url (shared base-URL resolution)", () => {
  const save = { url: process.env.HUB_PUBLIC_URL, port: process.env.HUB_PORT };
  afterEach(() => {
    process.env.HUB_PUBLIC_URL = save.url;
    process.env.HUB_PORT = save.port;
    if (save.url === undefined) delete process.env.HUB_PUBLIC_URL;
    if (save.port === undefined) delete process.env.HUB_PORT;
  });

  it("prefers HUB_PUBLIC_URL and strips trailing slashes", () => {
    process.env.HUB_PUBLIC_URL = "https://hub.example.com/";
    expect(hubBaseUrl("http://ignored")).toBe("https://hub.example.com");
  });

  it("falls back to the request-derived URL, then localhost:HUB_PORT", () => {
    delete process.env.HUB_PUBLIC_URL;
    expect(hubBaseUrl("http://req.host")).toBe("http://req.host");
    process.env.HUB_PORT = "3000";
    expect(hubBaseUrl()).toBe("http://localhost:3000");
  });

  it("maps http→ws and https→wss and appends /agent", () => {
    delete process.env.HUB_PUBLIC_URL;
    expect(agentWsUrl("http://h")).toBe("ws://h/agent");
    expect(agentWsUrl("https://h")).toBe("wss://h/agent");
  });

  it("publicUrlFrom prefers x-forwarded-host + first x-forwarded-proto, else host, else undefined", () => {
    expect(publicUrlFrom({ headers: { "x-forwarded-host": "fwd.host", "x-forwarded-proto": "https,http", host: "direct" } })).toBe("https://fwd.host");
    expect(publicUrlFrom({ headers: { host: "direct" } })).toBe("http://direct");
    expect(publicUrlFrom({ headers: {} })).toBeUndefined();
  });
});
