import { describe, it, expect, beforeEach, vi } from "vitest";
import { apiFetch, tokens } from "./api";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiFetch 401 → refresh → retry", () => {
  beforeEach(() => {
    localStorage.clear();
    tokens.set({ accessToken: "old-access", refreshToken: "rt" });
  });

  it("refreshes on 401 and retries with the new token", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ url: String(url), auth });
      if (url.toString().endsWith("/auth/refresh")) {
        return jsonRes(200, {
          accessToken: "new-access",
          refreshToken: "new-rt",
        });
      }
      if (auth === "Bearer old-access") return jsonRes(401, { message: "expired" });
      return jsonRes(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await apiFetch<{ ok: boolean }>("/servers");
    expect(out.ok).toBe(true);
    expect(tokens.access()).toBe("new-access");
    // first (401), refresh, retry with new token
    expect(calls.some((c) => c.auth === "Bearer new-access")).toBe(true);

    vi.unstubAllGlobals();
  });

  it("throws ApiError on non-ok without refresh", async () => {
    const fetchMock = vi.fn(async () => jsonRes(409, { message: "conflict" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiFetch("/x", {}, false)).rejects.toThrow(/conflict/);
    vi.unstubAllGlobals();
  });
});
