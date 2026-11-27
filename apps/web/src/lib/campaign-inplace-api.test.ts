import { describe, it, expect, afterEach, vi } from "vitest";
import { api, ApiError } from "./api";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Every call goes to the route the hub defines, with the right verb and body. */
describe("campaign and in-place takeover api client", () => {
  afterEach(() => vi.unstubAllGlobals());
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const stub = () => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return jsonRes(200, {});
      }),
    );
  };

  it("campaign routes", async () => {
    stub();
    await api.campaignPlacement("s/1", "h".repeat(32));
    await api.planCampaign({ sessionId: "s1", planHash: "a".repeat(32), placements: [{ sourceServerRef: "a", kind: "in-place", targetServerId: null }] });
    await api.createCampaign({ sessionId: "s1", planHash: "a".repeat(32), placements: [], confirm: 0 });
    await api.listCampaigns("t 1");
    await api.getCampaign("c/1");
    await api.cancelCampaign("c1");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `/api/v1/migration-campaigns/placement?sessionId=s%2F1&planHash=${"h".repeat(32)}`],
      ["POST", "/api/v1/migration-campaigns/plan"],
      ["POST", "/api/v1/migration-campaigns"],
      ["GET", "/api/v1/migration-campaigns?teamId=t%201"],
      ["GET", "/api/v1/migration-campaigns/c%2F1"],
      ["POST", "/api/v1/migration-campaigns/c1/cancel"],
    ]);
    expect(calls[1].body).toEqual({ sessionId: "s1", planHash: "a".repeat(32), placements: [{ sourceServerRef: "a", kind: "in-place", targetServerId: null }] });
  });

  it("in-place routes: the typed name travels only to swap and give back", async () => {
    stub();
    await api.planInPlace({ serverId: "srv1", opId: "op1" });
    await api.listInPlace("srv 1");
    await api.getInPlace("tk1");
    await api.testInPlace("tk1");
    await api.swapInPlace("tk1", "edge-box");
    await api.verifyInPlace("tk1");
    await api.giveBackInPlace("tk1", "edge-box");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "/api/v1/coolify-inplace/plan"],
      ["GET", "/api/v1/coolify-inplace?serverId=srv%201"],
      ["GET", "/api/v1/coolify-inplace/tk1"],
      ["POST", "/api/v1/coolify-inplace/tk1/test"],
      ["POST", "/api/v1/coolify-inplace/tk1/swap"],
      ["POST", "/api/v1/coolify-inplace/tk1/verify"],
      ["POST", "/api/v1/coolify-inplace/tk1/give-back"],
    ]);
    expect(calls[0].body).toEqual({ serverId: "srv1", opId: "op1", rebuild: [] });
    expect(calls[4].body).toEqual({ confirm: "edge-box" });
    expect(calls[6].body).toEqual({ confirm: "edge-box" });
    expect(calls[3].body).toBeUndefined();
    expect(calls[5].body).toBeUndefined();
  });
});

describe("run in-place api client", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reads the takeover a run carries from its own route", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (seen.push(String(url)), jsonRes(200, { id: "tk1", status: "TESTING", items: [] }))));
    expect(await api.getRunInPlace("run/1")).toMatchObject({ id: "tk1" });
    expect(seen).toEqual(["/api/v1/coolify-inplace/run/run%2F1"]);
  });
  it("a run with no takeover yet is null, any other failure is still an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(404, { message: "takeover-not-found" })));
    expect(await api.getRunInPlace("r1")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(500, { message: "boom" })));
    await expect(api.getRunInPlace("r1")).rejects.toBeInstanceOf(ApiError);
  });
  it("sends the rebuild list with the campaign plan", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), jsonRes(200, {}))));
    await api.planCampaign({ sessionId: "s1", planHash: "a".repeat(32), placements: [], rebuild: ["app:a:web"] });
    expect(bodies[0]).toMatchObject({ rebuild: ["app:a:web"] });
  });
});
