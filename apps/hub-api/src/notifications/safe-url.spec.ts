jest.mock("node:dns/promises");
jest.mock("node:https");
jest.mock("node:http");

import { lookup } from "node:dns/promises";
import https from "node:https";
import http from "node:http";
import { assertSafeUrl, assertSafeHost, resolveSafeAddress, safeSend, SsrfError, normHost } from "./safe-url";

const mockLookup = lookup as unknown as jest.Mock;
const PUBLIC = [{ address: "203.0.113.7", family: 4 }];

/** Make node:https/node:http `request` invoke its callback with a fake response of `status`. */
function stubRequest(mod: typeof https | typeof http, status: number) {
  (mod.request as jest.Mock).mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
    cb({ resume: jest.fn(), statusCode: status });
    return { on: jest.fn(), write: jest.fn(), end: jest.fn(), destroy: jest.fn() };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockResolvedValue(PUBLIC);
});

describe("assertSafeUrl — SSRF rejection", () => {
  const OPTS = { allowPrivate: false };

  it.each([
    ["http://127.0.0.1", "loopback literal"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://localhost", "localhost name"],
    ["http://x.internal", ".internal suffix"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://expected.com@169.254.169.254/", "userinfo @ trick"],
    ["http://2130706433/", "decimal IPv4 → 127.0.0.1"],
    ["http://0x7f.0.0.1/", "hex IPv4 shorthand"],
  ])("rejects %s (%s)", async (url) => {
    await expect(assertSafeUrl(url, OPTS)).rejects.toBeInstanceOf(SsrfError);
  });

  it.each([["file:///etc/passwd"], ["gopher://x/"], ["ftp://x/"], ["not a url"]])(
    "rejects non-http(s) scheme / invalid: %s",
    async (url) => {
      await expect(assertSafeUrl(url, OPTS)).rejects.toBeInstanceOf(SsrfError);
    },
  );

  it("rejects a hostname that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertSafeUrl("http://evil.example", OPTS)).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects if ANY resolved record is unsafe (multi-record)", async () => {
    mockLookup.mockResolvedValue([{ address: "203.0.113.7", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    await expect(assertSafeUrl("http://evil.example", OPTS)).rejects.toBeInstanceOf(SsrfError);
  });

  it("fails closed when DNS resolution errors", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSafeUrl("http://unresolvable.example", OPTS)).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("assertSafeUrl — accept", () => {
  it("accepts a public host", async () => {
    await expect(assertSafeUrl("https://hooks.example.com/x", { allowPrivate: false })).resolves.toBeUndefined();
  });

  it("accepts a private target only when allowPrivate is set", async () => {
    await expect(assertSafeUrl("http://192.168.1.10", { allowPrivate: false })).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl("http://192.168.1.10", { allowPrivate: true })).resolves.toBeUndefined();
    // ...but metadata stays blocked even with allowPrivate
    await expect(assertSafeUrl("http://169.254.169.254", { allowPrivate: true })).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("assertSafeHost (SMTP bare host)", () => {
  it("rejects localhost and resolves a public host", async () => {
    await expect(assertSafeHost("localhost", { allowPrivate: false })).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeHost("mail.example.com", { allowPrivate: false })).resolves.toBeUndefined();
  });

  it("rejects an expanded/alternate-notation IPv6 literal that folds to loopback/metadata (no URL parse ran)", async () => {
    // The raw-host path (SMTP) does not go through new URL, so normHost must canonicalize these itself.
    for (const host of [
      "0:0:0:0:0:ffff:7f00:1", // = ::ffff:127.0.0.1 (mapped loopback)
      "0:0:0:0:0:ffff:a9fe:a9fe", // = ::ffff:169.254.169.254 (mapped metadata)
      "fd00:0ec2:0:0:0:0:0:254", // = fd00:ec2::254 (AWS IPv6 IMDS)
    ]) {
      await expect(assertSafeHost(host, { allowPrivate: true })).rejects.toBeInstanceOf(SsrfError);
    }
  });
});

describe("resolveSafeAddress — DNS-rebind pin", () => {
  it("passes create-time validation but blocks the flipped record at send-time", async () => {
    mockLookup.mockResolvedValueOnce(PUBLIC).mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    // create/update time: resolves public → OK
    await expect(assertSafeUrl("http://rebind.example", { allowPrivate: false })).resolves.toBeUndefined();
    // send time re-resolves → now private → blocked (the pin re-validates every send)
    await expect(resolveSafeAddress("rebind.example", { allowPrivate: false })).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("safeSend — pins the validated IP, no redirect follow", () => {
  it("dials the resolved IP with SNI + Host header set to the original name", async () => {
    stubRequest(https, 200);
    await safeSend(
      "https://hooks.example.com/path?x=1",
      "BODY",
      { "content-type": "application/json", "X-Foo": "bar" },
      { allowPrivate: false },
    );
    const opts = (https.request as jest.Mock).mock.calls[0][0];
    expect(opts.host).toBe("203.0.113.7"); // the pin — dial the validated IP, not the name
    expect(opts.servername).toBe("hooks.example.com"); // TLS SNI/cert still vs the name
    expect(opts.headers.host).toBe("hooks.example.com"); // vhost routing preserved
    expect(opts.path).toBe("/path?x=1");
    expect(opts.headers["X-Foo"]).toBe("bar");
    expect(http.request).not.toHaveBeenCalled();
  });

  it("does NOT follow a redirect (3xx → error)", async () => {
    stubRequest(https, 302);
    await expect(safeSend("https://hooks.example.com/", "{}", {}, { allowPrivate: false })).rejects.toThrow(/HTTP 302/);
  });

  it("uses http for an http:// url", async () => {
    stubRequest(http, 204);
    await safeSend("http://hooks.example.com/", "{}", {}, { allowPrivate: false });
    expect(http.request).toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });

  it("refuses to send to a blocked target before any request is made", async () => {
    stubRequest(https, 200);
    await expect(safeSend("http://169.254.169.254/", "{}", {}, { allowPrivate: false })).rejects.toBeInstanceOf(SsrfError);
    expect(https.request).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });
});

describe("normHost", () => {
  it("strips IPv6 brackets, a trailing dot, and lowercases", () => {
    expect(normHost("[::1]")).toBe("::1");
    expect(normHost("Example.COM.")).toBe("example.com");
  });
});
