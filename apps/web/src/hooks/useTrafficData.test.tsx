import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { api } from "../lib/api";
import type { TrafficCountries, TrafficPaths, TrafficSummary } from "../lib/types";
import { useTrafficData } from "./useTrafficData";

afterEach(() => vi.restoreAllMocks());

const summary = { range: "24h", times: [1], requests: [5], totals: { requests: 5 } } as unknown as TrafficSummary;
const emptySummary = { range: "24h", times: [], requests: [], totals: { requests: 0 } } as unknown as TrafficSummary;
const paths = { range: "24h", paths: [{ path: "/", requests: 5, bytes: 1 }], other: { requests: 0, bytes: 0 } } as TrafficPaths;
const emptyPaths = { range: "24h", paths: [], other: { requests: 0, bytes: 0 } } as TrafficPaths;
const countries = { range: "24h", countries: [] } as TrafficCountries;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe("useTrafficData", () => {
  it("fetches the three queries with the scope (incl. appId) and derives loading/empty", async () => {
    const s = vi.spyOn(api, "getTrafficSummary").mockResolvedValue(summary);
    const p = vi.spyOn(api, "getTrafficPaths").mockResolvedValue(paths);
    const c = vi.spyOn(api, "getTrafficCountries").mockResolvedValue(countries);
    const { result } = renderHook(() => useTrafficData({ range: "7d", teamId: "t1", domain: "a.com", appId: "app1" }), { wrapper });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(s).toHaveBeenCalledWith({ range: "7d", teamId: "t1", domain: "a.com", appId: "app1" });
    expect(p).toHaveBeenCalledWith(expect.objectContaining({ appId: "app1", limit: 20 }));
    expect(c).toHaveBeenCalledWith(expect.objectContaining({ appId: "app1", limit: 250 }));
    expect(result.current.failed).toBe(false);
    expect(result.current.empty).toBe(false);
  });

  it("empty when every query returns nothing, failed only when all three fail", async () => {
    vi.spyOn(api, "getTrafficSummary").mockResolvedValue(emptySummary);
    vi.spyOn(api, "getTrafficPaths").mockResolvedValue(emptyPaths);
    vi.spyOn(api, "getTrafficCountries").mockResolvedValue(countries);
    const ok = renderHook(() => useTrafficData({ range: "24h", teamId: "t1" }), { wrapper });
    await waitFor(() => expect(ok.result.current.loading).toBe(false));
    expect(ok.result.current.empty).toBe(true);

    vi.spyOn(api, "getTrafficSummary").mockRejectedValue(new Error("x"));
    vi.spyOn(api, "getTrafficPaths").mockRejectedValue(new Error("x"));
    vi.spyOn(api, "getTrafficCountries").mockRejectedValue(new Error("x"));
    const bad = renderHook(() => useTrafficData({ range: "24h", teamId: "t1" }), { wrapper });
    await waitFor(() => expect(bad.result.current.failed).toBe(true));
  });

  it("enabled: false requests nothing", () => {
    const s = vi.spyOn(api, "getTrafficSummary").mockResolvedValue(summary);
    const { result } = renderHook(() => useTrafficData({ range: "24h", teamId: "t1", appId: "a", enabled: false }), { wrapper });
    expect(s).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
