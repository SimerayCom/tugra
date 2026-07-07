import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useMetricsStream } from "./useMetricsStream";
import { tokens } from "../lib/api";
import type { MetricsSample } from "../lib/types";

function sample(over: Partial<MetricsSample> = {}): MetricsSample {
  return {
    ts: 1000,
    cpu: 10,
    memUsed: 1,
    memTotal: 2,
    diskUsed: 1,
    diskTotal: 2,
    netRx: 0,
    netTx: 0,
    ...over,
  };
}

function streamFrom(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < parts.length) controller.enqueue(enc.encode(parts[i++]));
      else controller.close();
    },
  });
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

let qc: QueryClient;
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useMetricsStream", () => {
  beforeEach(() => {
    qc = new QueryClient();
    localStorage.clear();
    tokens.set({ accessToken: "acc", refreshToken: "rt" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("appends streamed samples to the metrics query cache and ignores pings", async () => {
    qc.setQueryData<MetricsSample[]>(["metrics", "s1"], [sample({ ts: 1000, cpu: 1 })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        body: streamFrom([
          frame({ type: "ping" }),
          frame(sample({ ts: 2000, cpu: 2 })),
          frame(sample({ ts: 3000, cpu: 3 })),
        ]),
      }) as Response),
    );

    const { unmount } = renderHook(() => useMetricsStream("s1", true), { wrapper });

    await waitFor(() => {
      const data = qc.getQueryData<MetricsSample[]>(["metrics", "s1"]);
      expect(data?.map((m) => m.cpu)).toEqual([1, 2, 3]);
    });
    unmount(); // stop the reconnect loop
  });

  it("drops duplicate / out-of-order samples", async () => {
    qc.setQueryData<MetricsSample[]>(["metrics", "s1"], [sample({ ts: 5000, cpu: 5 })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        body: streamFrom([
          frame(sample({ ts: 5000, cpu: 99 })), // duplicate ts
          frame(sample({ ts: 4000, cpu: 88 })), // older
          frame(sample({ ts: 6000, cpu: 6 })), // newer — kept
        ]),
      }) as Response),
    );

    const { unmount } = renderHook(() => useMetricsStream("s1", true), { wrapper });

    await waitFor(() => {
      const data = qc.getQueryData<MetricsSample[]>(["metrics", "s1"]);
      expect(data?.map((m) => m.cpu)).toEqual([5, 6]);
    });
    unmount(); // stop the reconnect loop
  });

  it("caps the series at 60 samples", async () => {
    const seed = Array.from({ length: 60 }, (_, i) => sample({ ts: 1000 + i, cpu: i }));
    qc.setQueryData<MetricsSample[]>(["metrics", "s1"], seed);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ body: streamFrom([frame(sample({ ts: 9999, cpu: 42 }))]) }) as Response),
    );

    const { unmount } = renderHook(() => useMetricsStream("s1", true), { wrapper });

    await waitFor(() => {
      const data = qc.getQueryData<MetricsSample[]>(["metrics", "s1"]);
      expect(data).toHaveLength(60);
      expect(data?.[59].cpu).toBe(42);
      expect(data?.[0].ts).toBe(1001); // oldest dropped
    });
    unmount(); // stop the reconnect loop
  });

  it("does not fetch when inactive", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useMetricsStream("s1", false), { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the request on unmount", async () => {
    let captured: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        captured = init?.signal ?? undefined;
        return { body: streamFrom([]) } as Response;
      }),
    );
    const { unmount } = renderHook(() => useMetricsStream("s1", true), { wrapper });
    await waitFor(() => expect(captured).toBeDefined());
    unmount();
    expect(captured!.aborted).toBe(true);
  });
});
