import { securityHeadersMiddleware, SECURITY_HEADERS } from "./security-headers";

describe("securityHeadersMiddleware", () => {
  it("sets every baseline header, drops X-Powered-By and calls next", () => {
    const set: Record<string, string> = {};
    const removed: string[] = [];
    const res = { setHeader: (k: string, v: string) => { set[k] = v; }, removeHeader: (k: string) => removed.push(k) };
    const next = jest.fn();
    securityHeadersMiddleware({} as never, res as never, next);
    expect(set).toEqual(SECURITY_HEADERS);
    expect(set["X-Frame-Options"]).toBe("DENY");
    expect(set["X-Content-Type-Options"]).toBe("nosniff");
    expect(removed).toContain("X-Powered-By");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
