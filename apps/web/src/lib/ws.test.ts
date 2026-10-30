import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  wsBase,
  terminalBase,
  terminalUrl,
  encodeInput,
  encodeResize,
  decodeOutput,
  bytesToB64,
  connectTerminal,
  connectTerminalWithRetry,
  terminalQuery,
  targetFromQuery,
} from "./ws";

describe("ws url helpers", () => {
  it("converts http→ws and https→wss", () => {
    expect(wsBase("http://localhost:3000")).toBe("ws://localhost:3000");
    expect(wsBase("https://hub.example.com")).toBe("wss://hub.example.com");
  });

  it("builds terminal URLs for app, database and server targets", () => {
    expect(terminalUrl({ app: "a1" }, "http://localhost:3000")).toBe("ws://localhost:3000/terminal?app=a1");
    expect(terminalUrl({ database: "d1" }, "https://h")).toBe("wss://h/terminal?database=d1");
    expect(terminalUrl({ server: "s1" }, "https://h")).toBe("wss://h/terminal?server=s1");
  });

  it("unbaked, resolves the terminal base from the runtime origin (published image → single-origin)", () => {
    // No baked NEXT_PUBLIC_API_URL → hubPublicUrl() uses window.location.origin so a pulled image works
    // for any --domain deployment that routes /terminal to the hub on the same origin. Use a DISTINCT
    // origin (not the localhost dev fallback) so this genuinely exercises the window.origin branch — a
    // regression that drops it would return the fallback and fail here.
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const orig = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", { value: { origin: "https://panel.example.com" }, configurable: true });
    try {
      expect(terminalBase()).toBe("wss://panel.example.com");
    } finally {
      if (orig) Object.defineProperty(window, "location", orig);
      vi.unstubAllEnvs();
    }
  });

  it("honours a baked NEXT_PUBLIC_API_URL when present (build-from-source / explicit override)", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://hub.example.com");
    expect(terminalBase()).toBe("wss://hub.example.com");
    vi.unstubAllEnvs();
  });
});

describe("terminal message encoding", () => {
  it("encodes stdin as base64 and decodes output back (binary-safe)", () => {
    const msg = JSON.parse(encodeInput("ls -la\n"));
    expect(msg.type).toBe("term_input");
    expect(decodeOutput(msg.data)).toBe("ls -la\n");
  });

  it("round-trips control bytes without corruption", () => {
    const raw = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a, 0x00, 0xff]); // ESC [ 2 J NUL 0xff
    const b64 = bytesToB64(raw);
    // decodeOutput uses TextDecoder; assert base64 itself is exact
    expect(atob(b64)).toBe(String.fromCharCode(0x1b, 0x5b, 0x32, 0x4a, 0x00, 0xff));
  });

  it("encodes resize", () => {
    expect(JSON.parse(encodeResize(120, 40))).toEqual({ type: "term_resize", cols: 120, rows: 40 });
  });
});

class FakeWS {
  static last: FakeWS | undefined;
  static OPEN = 1;
  OPEN = 1;
  readyState = 1;
  url: string;
  protocols: string | string[] | undefined;
  onopen: (() => void) | null = null;
  onclose: ((ev?: { code: number; reason: string }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWS.last = this;
  }
  send(raw: string) {
    this.sent.push(raw);
  }
  close() {
    this.closed = true;
  }
}

const FakeWSCtor = FakeWS as unknown as typeof WebSocket;

describe("connectTerminal", () => {
  beforeEach(() => {
    FakeWS.last = undefined;
  });

  it("fetches a ticket then opens with the bearer subprotocol carrying it, and routes events", async () => {
    const events: unknown[] = [];
    const conn = connectTerminal(
      { server: "s1" },
      { onEvent: (e) => events.push(e) },
      { WS: FakeWSCtor, fetchTicket: async () => "tkt-123" },
    );
    // The socket opens only after the ticket promise resolves.
    await vi.waitFor(() => expect(FakeWS.last).toBeDefined());
    const created = FakeWS.last!;
    expect(created.protocols).toEqual(["tugra.bearer", "tkt-123"]);

    created.onmessage!({ data: JSON.stringify({ type: "term_output", sessionId: "x", data: "aGk=" }) });
    expect(events).toEqual([{ type: "term_output", sessionId: "x", data: "aGk=" }]);

    conn.send("hello");
    expect(created.sent).toContain("hello");
    conn.close();
    expect(created.closed).toBe(true);
  });

  it("does not open the socket if closed before the ticket resolves", async () => {
    let release: (t: string) => void = () => {};
    const conn = connectTerminal(
      { server: "s1" },
      { onEvent: () => {} },
      { WS: FakeWSCtor, fetchTicket: () => new Promise<string>((r) => (release = r)) },
    );
    conn.close(); // close before the ticket arrives
    release("late-ticket");
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(FakeWS.last).toBeUndefined(); // never opened
  });

  it("ignores malformed frames", async () => {
    const events: unknown[] = [];
    connectTerminal({ app: "a1" }, { onEvent: (e) => events.push(e) }, { WS: FakeWSCtor, fetchTicket: async () => "t" });
    await vi.waitFor(() => expect(FakeWS.last).toBeDefined());
    FakeWS.last!.onmessage!({ data: "not json" });
    expect(events).toEqual([]);
  });
});

describe("terminalQuery / targetFromQuery round-trip", () => {
  it("round-trips every target shape", () => {
    for (const tgt of [{ server: "s1" }, { database: "d1" }, { app: "a1" }, { app: "a1", container: "tugra_a1-web-1" }] as const) {
      expect(targetFromQuery(new URLSearchParams(terminalQuery(tgt)))).toEqual(tgt);
    }
  });
  it("returns null when no target param is present", () => {
    expect(targetFromQuery(new URLSearchParams("foo=bar"))).toBeNull();
  });
});

describe("connectTerminalWithRetry", () => {
  beforeEach(() => { FakeWS.last = undefined; });
  const openLatest = async () => { await vi.waitFor(() => expect(FakeWS.last).toBeDefined()); return FakeWS.last!; };

  it("marks denied and does NOT retry on a 1008 policy close", async () => {
    const statuses: string[] = [];
    let tickets = 0;
    const conn = connectTerminalWithRetry(
      { server: "s1" },
      { onEvent: () => {}, onStatus: (s) => statuses.push(s) },
      { WS: FakeWSCtor, fetchTicket: async () => `t${++tickets}`, rand: () => 0 },
    );
    const ws = await openLatest();
    ws.onclose!({ code: 1008, reason: "terminal capability not granted for this server" });
    expect(statuses).toContain("denied");
    expect(statuses).not.toContain("reconnecting");
    expect(tickets).toBe(1); // never re-connected
    conn.close();
  });

  it("does NOT retry on a clean 1000 exit", async () => {
    const statuses: string[] = [];
    const conn = connectTerminalWithRetry({ server: "s1" }, { onEvent: () => {}, onStatus: (s) => statuses.push(s) }, { WS: FakeWSCtor, fetchTicket: async () => "t", rand: () => 0 });
    const ws = await openLatest();
    ws.onclose!({ code: 1000, reason: "exited" });
    expect(statuses).toContain("closed");
    expect(statuses).not.toContain("reconnecting");
    conn.close();
  });

  it("enters reconnecting on a transient (1006) drop", async () => {
    const statuses: string[] = [];
    const conn = connectTerminalWithRetry({ server: "s1" }, { onEvent: () => {}, onStatus: (s) => statuses.push(s) }, { WS: FakeWSCtor, fetchTicket: async () => "t", rand: () => 0 });
    const ws = await openLatest();
    ws.onclose!({ code: 1006, reason: "" });
    expect(statuses).toContain("reconnecting");
    conn.close(); // cancel the pending backoff timer
  });

  it("reports open and sends on the live socket", async () => {
    const statuses: string[] = [];
    const conn = connectTerminalWithRetry({ server: "s1" }, { onEvent: () => {}, onStatus: (s) => statuses.push(s) }, { WS: FakeWSCtor, fetchTicket: async () => "t", rand: () => 0 });
    const ws = await openLatest();
    ws.onopen!();
    expect(statuses).toContain("open");
    conn.send("x");
    expect(ws.sent).toContain("x");
    conn.close();
  });
});
