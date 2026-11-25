import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { api } from "../lib/api";
import { scannable, useBulkScan } from "./scan-bulk";
import type { ServerView } from "../lib/types";

const srv = (id: string, over: Partial<ServerView> = {}) =>
  ({ id, name: id, status: "ONLINE", canOps: true, canWrite: true, capabilities: ["bulk"], ...over }) as unknown as ServerView;

describe("bulk scan", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("only targets selected, online servers the caller can operate that grant the bulk capability", () => {
    const all = [srv("a"), srv("b", { status: "OFFLINE" }), srv("c", { canOps: false }), srv("d", { capabilities: [] }), srv("e")];
    expect(scannable(all, ["a", "b", "c", "d"]).map((s) => s.id)).toEqual(["a"]);
  });

  it("scans every target with bounded concurrency and counts failures without throwing", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(api, "runServerScan").mockImplementation(async (id: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (id === "x2") throw new Error("boom");
      return { report: null };
    });
    const qc = new QueryClient();
    const { result } = renderHook(() => useBulkScan(2), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
    let res = { ok: 0, failed: 0 };
    await act(async () => { res = await result.current.run(["x1", "x2", "x3", "x4", "x5"].map((id) => srv(id))); });
    expect(res).toEqual({ ok: 4, failed: 1 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.current.progress).toBeNull();
  });
});
