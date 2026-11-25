import { describe, it, expect, afterEach, vi } from "vitest";
import { api } from "./api";

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
    await api.swapInPlace("tk1", "olgu-box");
    await api.verifyInPlace("tk1");
    await api.giveBackInPlace("tk1", "olgu-box");
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
    expect(calls[4].body).toEqual({ confirm: "olgu-box" });
    expect(calls[6].body).toEqual({ confirm: "olgu-box" });
    expect(calls[3].body).toBeUndefined();
    expect(calls[5].body).toBeUndefined();
  });
});
