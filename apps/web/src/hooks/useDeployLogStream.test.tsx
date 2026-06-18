import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useDeployLogStream } from "./useDeployLogStream";
import { tokens } from "../lib/api";

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

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useDeployLogStream", () => {
  beforeEach(() => {
    localStorage.clear();
    tokens.set({ accessToken: "acc", refreshToken: "rt" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("accumulates streamed chunks and captures the done result", async () => {
    const chunk = (d: string) => `data: ${JSON.stringify({ type: "chunk", data: d })}\n\n`;
    const done = `data: ${JSON.stringify({ type: "done", status: "SUCCESS", exitCode: 0, deploymentId: "d1" })}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ body: streamFrom([chunk("building "), chunk("done\n"), done]) }) as Response),
    );

    const { result } = renderHook(() => useDeployLogStream("app1", true), { wrapper });
    await waitFor(() => expect(result.current.done).toBe(true));
    expect(result.current.lines).toBe("building done\n");
    expect(result.current.status).toBe("SUCCESS");
    expect(result.current.exitCode).toBe(0);
  });

  it("does not fetch when inactive", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useDeployLogStream("app1", false), { wrapper });
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
    const { unmount } = renderHook(() => useDeployLogStream("app1", true), { wrapper });
    await waitFor(() => expect(captured).toBeDefined());
    unmount();
    expect(captured!.aborted).toBe(true);
  });
});
