import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useIsPro } from "./useIsPro";
import { api } from "../lib/api";

afterEach(cleanup);
let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
});
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

describe("useIsPro", () => {
  it("community → ready true, isPro false", async () => {
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: "community" } as never);
    const { result } = renderHook(() => useIsPro(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.isPro).toBe(false);
  });

  it("pro and cloud → isPro true", async () => {
    for (const e of ["pro", "cloud"]) {
      vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: e } as never);
      const { result } = renderHook(() => useIsPro(), { wrapper });
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.isPro).toBe(true);
      cleanup();
    }
  });

  it("pending → ready false", () => {
    vi.spyOn(api, "getInstanceStatus").mockReturnValue(new Promise(() => {}) as never);
    const { result } = renderHook(() => useIsPro(), { wrapper });
    expect(result.current.ready).toBe(false);
    expect(result.current.isPro).toBe(false);
  });
});
