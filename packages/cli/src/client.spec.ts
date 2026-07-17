import { TugraClient } from "./client";
import { formatTable } from "./output";

function res(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TugraClient", () => {
  it("sends the Bearer token and hits the /api/v1 path (trailing slash normalized)", async () => {
    const seen: { url: string; auth: string | null; method?: string }[] = [];
    const stub = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), method: init?.method });
      return res(200, [{ id: "s1" }]);
    });
    const rows = await new TugraClient({ hub: "https://h.example/", token: "tugra_pat_abc" }, stub).listServers();
    expect(rows).toEqual([{ id: "s1" }]);
    expect(seen[0].url).toBe("https://h.example/api/v1/servers");
    expect(seen[0].auth).toBe("Bearer tugra_pat_abc");
  });

  it("POSTs a deploy with an empty JSON body", async () => {
    const stub = jest.fn(async () => res(200, { ok: true }));
    await new TugraClient({ hub: "https://h", token: "t" }, stub).deployApp("app 1");
    expect(stub).toHaveBeenCalledWith(
      "https://h/api/v1/apps/app%201/deploy",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("throws ApiError carrying the hub's string message", async () => {
    const stub = jest.fn(async () => res(403, { statusCode: 403, message: "insufficient token scope", error: "Forbidden" }));
    await expect(new TugraClient({ hub: "https://h", token: "t" }, stub).listServers()).rejects.toMatchObject({
      status: 403,
      message: "insufficient token scope",
    });
  });

  it("joins an array message (zod validation errors)", async () => {
    const stub = jest.fn(async () => res(400, { message: ["name: Required", "url: Invalid"] }));
    await expect(new TugraClient({ hub: "https://h", token: "t" }, stub).listServers()).rejects.toMatchObject({
      status: 400,
      message: "name: Required; url: Invalid",
    });
  });

  it("getVersion hits bare /version with NO Authorization header", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const stub = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return res(200, { version: "0.1.0", protocol: 2, channel: "stable", commit: "", edition: "community" });
    });
    const v = await new TugraClient({ hub: "https://h", token: "t" }, stub).getVersion();
    expect(v.protocol).toBe(2);
    expect(seen[0].url).toBe("https://h/version");
    expect(seen[0].auth).toBeNull();
  });

  it("wraps a network failure as ApiError(status 0)", async () => {
    const stub = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(new TugraClient({ hub: "https://h", token: "t" }, stub).listServers()).rejects.toMatchObject({
      status: 0,
    });
  });

  it("servers ls renders a table from the API response (client → output)", async () => {
    const stub = jest.fn(async () =>
      res(200, [{ id: "s1", name: "prod", status: "ONLINE", publicIp: "1.2.3.4", os: "ubuntu" }]),
    );
    const rows = await new TugraClient({ hub: "https://h", token: "tugra_pat_x" }, stub).listServers();
    const table = formatTable(rows, [
      { key: "id", header: "ID" },
      { key: "name", header: "NAME" },
      { key: "status", header: "STATUS" },
    ]);
    expect(table).toContain("s1");
    expect(table).toContain("ONLINE");
  });
});
