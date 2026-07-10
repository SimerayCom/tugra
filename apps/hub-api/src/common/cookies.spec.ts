import {
  clearAuthCookies,
  cookiesSecure,
  parseCookies,
  setAuthCookies,
  TG_ACCESS,
  TG_CSRF,
  TG_REFRESH,
} from "./cookies";

describe("parseCookies", () => {
  it("parses a name=value; pairs header", () => {
    expect(parseCookies("a=1; b=2; c=hello")).toEqual({ a: "1", b: "2", c: "hello" });
  });

  it("returns an empty map for missing/empty headers", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  it("url-decodes values and tolerates '=' inside a value", () => {
    expect(parseCookies("tok=a%3Db%3Dc")).toEqual({ tok: "a=b=c" });
  });

  it("joins an array header (multiple Cookie headers)", () => {
    expect(parseCookies(["a=1", "b=2"])).toEqual({ a: "1", b: "2" });
  });

  it("ignores malformed segments with no '='", () => {
    expect(parseCookies("a=1; garbage; b=2")).toEqual({ a: "1", b: "2" });
  });

  it("falls back to the raw value on a malformed percent-sequence (no URIError crash)", () => {
    // decodeURIComponent('100%') throws — a foreign cookie must not crash the parser, and a valid
    // session cookie alongside it must still be readable.
    expect(parseCookies("pref=100%; tg_access=AT")).toEqual({ pref: "100%", tg_access: "AT" });
    expect(parseCookies("bad=%zz")).toEqual({ bad: "%zz" });
  });
});

describe("cookiesSecure", () => {
  const orig = { COOKIE_SECURE: process.env.COOKIE_SECURE, NODE_ENV: process.env.NODE_ENV };
  afterEach(() => {
    process.env.COOKIE_SECURE = orig.COOKIE_SECURE;
    (process.env as Record<string, string | undefined>).NODE_ENV = orig.NODE_ENV;
  });

  it("honors an explicit COOKIE_SECURE override", () => {
    process.env.COOKIE_SECURE = "true";
    expect(cookiesSecure()).toBe(true);
    process.env.COOKIE_SECURE = "false";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(cookiesSecure()).toBe(false); // explicit false wins over prod
  });

  it("defaults to on in production, off otherwise", () => {
    delete process.env.COOKIE_SECURE;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(cookiesSecure()).toBe(true);
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    expect(cookiesSecure()).toBe(false);
  });
});

describe("setAuthCookies", () => {
  function mockRes() {
    const calls: { name: string; value: string; options: Record<string, unknown> }[] = [];
    return {
      calls,
      cookie(name: string, value: string, options: Record<string, unknown>) {
        calls.push({ name, value, options });
      },
      clearCookie() {
        /* unused here */
      },
    };
  }

  it("sets httpOnly access + refresh and a JS-readable CSRF cookie, returning the CSRF value", () => {
    const res = mockRes();
    const csrf = setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    const access = res.calls.find((c) => c.name === TG_ACCESS)!;
    const refresh = res.calls.find((c) => c.name === TG_REFRESH)!;
    const csrfCookie = res.calls.find((c) => c.name === TG_CSRF)!;

    expect(access.value).toBe("AT");
    expect(access.options.httpOnly).toBe(true);
    expect(access.options.sameSite).toBe("lax");
    expect(refresh.value).toBe("RT");
    expect(refresh.options.httpOnly).toBe(true);
    // CSRF is readable by JS (double-submit) → httpOnly must be false.
    expect(csrfCookie.options.httpOnly).toBe(false);
    expect(csrfCookie.value).toBe(csrf);
    expect(csrf.length).toBeGreaterThan(20);
  });

  it("preserves a provided CSRF value (no rotation on refresh)", () => {
    const res = mockRes();
    const csrf = setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" }, { csrf: "keep-me" });
    expect(csrf).toBe("keep-me");
    expect(res.calls.find((c) => c.name === TG_CSRF)!.value).toBe("keep-me");
  });
});

describe("clearAuthCookies", () => {
  it("clears all three cookies", () => {
    const cleared: string[] = [];
    clearAuthCookies({
      cookie() {
        /* unused */
      },
      clearCookie(name: string) {
        cleared.push(name);
      },
    });
    expect(cleared.sort()).toEqual([TG_ACCESS, TG_CSRF, TG_REFRESH].sort());
  });
});
