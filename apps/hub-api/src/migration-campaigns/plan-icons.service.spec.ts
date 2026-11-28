import { PlanIconService } from "./plan-icons.service";
import type { FaviconRequest, FaviconResponse } from "../applications/favicon-fetcher";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const res = (over: Partial<FaviconResponse>): FaviconResponse => ({ status: 200, contentType: "image/png", location: null, body: PNG, ...over });

describe("PlanIconService", () => {
  it("fetches a site's favicon once and answers the next ask from memory", async () => {
    const s = new PlanIconService();
    s.fetchSite = jest.fn(async () => ({ mime: "image/png", data: PNG }));
    expect((await s.get("site", "App.Example.com"))?.mime).toBe("image/png");
    await s.get("site", "app.example.com");
    expect(s.fetchSite).toHaveBeenCalledTimes(1);
    expect(s.fetchSite).toHaveBeenCalledWith(["app.example.com"]);
  });
  it("never fetches for something that is not a DNS name or a GitHub login", async () => {
    const s = new PlanIconService();
    s.fetchSite = jest.fn(async () => null);
    s.transport = jest.fn(async () => res({}));
    for (const n of ["10.0.0.1", "localhost", "a/b", "http://x.com", "-x", "a--b", "x".repeat(40)]) expect(await s.get("site", n)).toBeNull();
    for (const n of ["a/b", "http://x.com", "-x", "a--b", "x".repeat(40), "a.b", "../x"]) expect(await s.get("github", n)).toBeNull();
    expect(s.fetchSite).not.toHaveBeenCalled();
    expect(s.transport).not.toHaveBeenCalled();
  });
  it("takes a GitHub avatar through the one redirect to GitHub's avatar host", async () => {
    const s = new PlanIconService();
    const seen: FaviconRequest[] = [];
    s.transport = jest.fn(async (r) => {
      seen.push(r);
      return r.host === "github.com" ? res({ status: 302, location: "https://avatars.githubusercontent.com/u/1?v=4", body: Buffer.alloc(0) }) : res({});
    });
    expect((await s.get("github", "octocat"))?.data.length).toBe(PNG.length);
    expect(seen.map((r) => r.host)).toEqual(["github.com", "avatars.githubusercontent.com"]);
  });
  it("does not follow a redirect to any other host, and refuses a body that is not a raster image", async () => {
    const s = new PlanIconService();
    s.transport = jest.fn(async () => res({ status: 302, location: "https://evil.example.com/x.png", body: Buffer.alloc(0) }));
    expect(await s.get("github", "octocat")).toBeNull();
    const t = new PlanIconService();
    t.transport = jest.fn(async () => res({ body: Buffer.from("<svg onload=alert(1)>") }));
    expect(await t.get("github", "someone")).toBeNull();
  });
  it("a miss is remembered for a while, and a failing fetch is a miss, not an error", async () => {
    const s = new PlanIconService();
    s.fetchSite = jest.fn(async () => { throw new Error("boom"); });
    expect(await s.get("site", "gone.example.com")).toBeNull();
    s.fetchSite = jest.fn(async () => ({ mime: "image/png", data: PNG }));
    expect(await s.get("site", "gone.example.com")).toBeNull();
    expect(s.fetchSite).not.toHaveBeenCalled();
  });
  it("caps the fetches one user may start per window, never the answers from memory, and another user is not affected", async () => {
    const s = new PlanIconService();
    let clock = 1_000;
    s.now = () => clock;
    s.fetchSite = jest.fn(async () => ({ mime: "image/png", data: PNG }));
    for (let i = 0; i < 400; i++) await s.get("site", `h${i}.example.com`, "u1");
    await expect(s.get("site", "one-more.example.com", "u1")).rejects.toMatchObject({ status: 429 });
    expect((await s.get("site", "h1.example.com", "u1"))?.mime).toBe("image/png"); // from memory
    expect((await s.get("site", "one-more.example.com", "u2"))?.mime).toBe("image/png");
    clock += 10 * 60_000;
    expect((await s.get("site", "one-more.example.com", "u1"))?.mime).toBe("image/png"); // a new window
  });
});
