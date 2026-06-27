import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  wsBase,
  terminalUrl,
  encodeInput,
  encodeResize,
  decodeOutput,
  bytesToB64,
  connectTerminal,
} from "./ws";
import { tokens } from "./api";

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
  onclose: (() => void) | null = null;
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
    localStorage.clear();
    tokens.set({ accessToken: "acc-tok", refreshToken: "rt" });
    FakeWS.last = undefined;
  });

  it("opens with the bearer subprotocol carrying the token and routes events", () => {
    const events: unknown[] = [];
    const conn = connectTerminal({ server: "s1" }, { onEvent: (e) => events.push(e) }, FakeWSCtor);
    const created = FakeWS.last!;
    expect(created.protocols).toEqual(["tugra.bearer", "acc-tok"]);

    created.onmessage!({ data: JSON.stringify({ type: "term_output", sessionId: "x", data: "aGk=" }) });
    expect(events).toEqual([{ type: "term_output", sessionId: "x", data: "aGk=" }]);

    conn.send("hello");
    expect(created.sent).toContain("hello");
    conn.close();
    expect(created.closed).toBe(true);
  });

  it("ignores malformed frames", () => {
    const events: unknown[] = [];
    connectTerminal({ app: "a1" }, { onEvent: (e) => events.push(e) }, FakeWSCtor);
    FakeWS.last!.onmessage!({ data: "not json" });
    expect(events).toEqual([]);
  });
});
