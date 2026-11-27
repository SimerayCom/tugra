import {
  FAVICON_MAX_BYTES,
  cleanHost,
  findFavicon,
  iconLinksFromHtml,
  isPublicIp,
  publicLookup,
  realFaviconTransport,
  sniffImage,
  type FaviconRequest,
  type FaviconResponse,
  type FaviconTransport,
} from "./favicon-fetcher";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);

const res = (over: Partial<FaviconResponse>): FaviconResponse => ({ status: 200, contentType: "image/png", location: null, body: PNG, ...over });
/** A fake site: path -> response, per "scheme://host". Records every request made. */
function site(routes: Record<string, FaviconResponse>) {
  const calls: FaviconRequest[] = [];
  const transport: FaviconTransport = async (r) => {
    calls.push(r);
    const hit = routes[`${r.scheme}://${r.host}${r.path}`];
    if (!hit) throw new Error("unreachable");
    return hit;
  };
  return { transport, calls };
}

describe("isPublicIp", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"])("allows %s", (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });
  it.each([
    "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255",
    "169.254.169.254", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1",
    "not-an-ip", "",
  ])("blocks %s", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });
  it("does not mistake the neighbours of private ranges", () => {
    expect(isPublicIp("172.15.0.1")).toBe(true);
    expect(isPublicIp("172.32.0.1")).toBe(true);
    expect(isPublicIp("100.63.0.1")).toBe(true);
    expect(isPublicIp("100.128.0.1")).toBe(true);
  });
});

describe("cleanHost", () => {
  it("accepts plain DNS names and lowercases them", () => {
    expect(cleanHost("Shop.Example.COM")).toBe("shop.example.com");
    expect(cleanHost("shop.example.com.")).toBe("shop.example.com");
  });
  it("rejects IPs, ports, paths, wildcards, credentials and empties", () => {
    for (const bad of ["127.0.0.1", "10.0.0.1", "[::1]", "localhost", "a.com:8080", "a.com/x", "*.a.com", "u@a.com", "", null, undefined, "a b.com"]) {
      expect(cleanHost(bad as string)).toBeNull();
    }
  });
});

describe("sniffImage", () => {
  it("recognises raster formats by their bytes and rejects svg and html", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(ICO)).toBe("image/x-icon");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).toBeNull();
    expect(sniffImage(Buffer.from("<!doctype html><html></html>"))).toBeNull();
  });
});

describe("iconLinksFromHtml", () => {
  it("lists icon links, preferring 32-64px, skipping data: and javascript: URLs", () => {
    const html = `<head>
      <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
      <link rel="icon" href="/big.png" sizes="512x512">
      <link rel="icon" type="image/png" href='/f32.png' sizes="32x32">
      <link rel="shortcut icon" href=/plain.ico>
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="stylesheet" href="/a.css">
    </head>`;
    expect(iconLinksFromHtml(html)).toEqual(["/f32.png", "/plain.ico", "/big.png", "/apple.png"]);
  });
});

describe("findFavicon", () => {
  it("reads /favicon.ico from the app's own domain", async () => {
    const { transport, calls } = site({ "https://shop.example.com/favicon.ico": res({ contentType: "image/x-icon", body: ICO }) });
    const out = await findFavicon(["shop.example.com"], { transport });
    expect(out).toEqual({ mime: "image/x-icon", data: ICO });
    expect(calls).toHaveLength(1);
  });

  it("falls back to the <link rel=icon> of the home page", async () => {
    const { transport } = site({
      "https://shop.example.com/favicon.ico": res({ status: 404, contentType: "text/html", body: Buffer.from("nope") }),
      "https://shop.example.com/": res({ contentType: "text/html; charset=utf-8", body: Buffer.from('<link rel="icon" href="/static/logo.png">') }),
      "https://shop.example.com/static/logo.png": res({}),
    });
    expect((await findFavicon(["shop.example.com"], { transport }))?.mime).toBe("image/png");
  });

  it("uses http when https is unreachable", async () => {
    const { transport } = site({ "http://shop.example.com/favicon.ico": res({}) });
    expect(await findFavicon(["shop.example.com"], { transport })).not.toBeNull();
  });

  it("follows a redirect to the www form of the same site", async () => {
    const { transport } = site({
      "https://example.com/favicon.ico": res({ status: 301, contentType: null, location: "https://www.example.com/favicon.ico", body: Buffer.alloc(0) }),
      "https://www.example.com/favicon.ico": res({}),
    });
    expect(await findFavicon(["example.com"], { transport })).not.toBeNull();
  });

  it("never follows a redirect to another host, an IP, another port or a credentialed URL", async () => {
    for (const location of ["https://evil.test/favicon.ico", "http://169.254.169.254/latest/meta-data", "https://127.0.0.1/x", "https://example.com:8443/x", "https://u:p@example.com/x", "ftp://example.com/x", "//evil.test/x"]) {
      const { transport, calls } = site({
        "https://example.com/favicon.ico": res({ status: 302, contentType: null, location, body: Buffer.alloc(0) }),
        "https://example.com/": res({ status: 404, contentType: "text/html", body: Buffer.alloc(0) }),
      });
      expect(await findFavicon(["example.com"], { transport, schemes: ["https"] })).toBeNull();
      expect(calls.every((c) => c.host === "example.com")).toBe(true);
    }
  });

  it("stops after three redirects", async () => {
    const calls: FaviconRequest[] = [];
    const transport: FaviconTransport = async (r) => {
      calls.push(r);
      return res({ status: 302, contentType: null, location: `https://example.com/r${calls.length}`, body: Buffer.alloc(0) });
    };
    expect(await findFavicon(["example.com"], { transport, schemes: ["https"] })).toBeNull();
    expect(calls.filter((c) => c.path.startsWith("/favicon") || c.path.startsWith("/r")).length).toBeLessThanOrEqual(8);
  });

  it("ignores a page icon URL on a host the app does not own", async () => {
    const { transport, calls } = site({
      "https://example.com/favicon.ico": res({ status: 404, contentType: "text/html", body: Buffer.alloc(0) }),
      "https://example.com/": res({ contentType: "text/html", body: Buffer.from('<link rel="icon" href="https://cdn.evil.test/i.png"><link rel="icon" href="http://10.0.0.1/i.png">') }),
    });
    expect(await findFavicon(["example.com"], { transport, schemes: ["https"] })).toBeNull();
    expect(calls.map((c) => c.host)).toEqual(["example.com", "example.com"]);
  });

  it("accepts an icon URL on another of the app's own hostnames", async () => {
    const { transport } = site({
      "https://example.com/favicon.ico": res({ status: 404, contentType: "text/html", body: Buffer.alloc(0) }),
      "https://example.com/": res({ contentType: "text/html", body: Buffer.from('<link rel="icon" href="https://static.example.com/i.png">') }),
      "https://static.example.com/i.png": res({}),
    });
    expect(await findFavicon(["example.com", "static.example.com"], { transport, schemes: ["https"] })).not.toBeNull();
  });

  it("rejects a non-image content type, an oversize body, and bytes that are not an image", async () => {
    const cases: FaviconResponse[] = [
      res({ contentType: "text/html" }),
      res({ contentType: null }),
      res({ body: Buffer.concat([PNG, Buffer.alloc(FAVICON_MAX_BYTES)]) }),
      res({ body: Buffer.from("<svg><script>alert(1)</script></svg>"), contentType: "image/svg+xml" }),
      res({ body: Buffer.from("<html>not an image at all</html>"), contentType: "image/png" }),
      res({ body: Buffer.alloc(0) }),
    ];
    for (const c of cases) {
      const { transport } = site({ "https://example.com/favicon.ico": c, "https://example.com/": res({ status: 404, contentType: "text/html" }) });
      expect(await findFavicon(["example.com"], { transport, schemes: ["https"] })).toBeNull();
    }
  });

  it("labels the mime from the bytes, not from the header", async () => {
    const { transport } = site({ "https://example.com/favicon.ico": res({ contentType: "image/jpeg", body: PNG }) });
    expect((await findFavicon(["example.com"], { transport }))?.mime).toBe("image/png");
  });

  it("makes no request for an IP, an unconfigured domain or a junk hostname", async () => {
    for (const d of [["10.0.0.1"], ["localhost"], [null], [], ["a.com/../x"], ["127.0.0.1"]]) {
      const { transport, calls } = site({});
      expect(await findFavicon(d as string[], { transport })).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it("only ever asks the primary hostname", async () => {
    const { transport, calls } = site({});
    await findFavicon(["a.example.com", "b.example.com"], { transport });
    expect(new Set(calls.map((c) => c.host))).toEqual(new Set(["a.example.com"]));
  });

  it("returns null instead of throwing when the transport fails", async () => {
    const transport: FaviconTransport = async () => {
      throw new Error("blocked-address");
    };
    expect(await findFavicon(["example.com"], { transport })).toBeNull();
  });
});

describe("the real transport", () => {
  it("refuses a name that resolves to a loopback address (DNS guard)", async () => {
    const err = await new Promise<Error | null>((resolve) => publicLookup("localhost", {}, (e) => resolve(e)));
    expect(err?.message).toMatch(/blocked-address/);
  });

  it("never connects to a loopback host", async () => {
    await expect(realFaviconTransport({ scheme: "http", host: "localhost", path: "/favicon.ico" })).rejects.toThrow(/blocked-address/);
  });
});
