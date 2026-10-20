import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useContainerLogStream, nextBackoff } from "./useContainerLogStream";

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

describe("nextBackoff", () => {
  it("resets to the floor after a productive connection", () => {
    expect(nextBackoff(8000, true)).toBe(1000);
    expect(nextBackoff(15000, true)).toBe(1000);
  });
  it("grows exponentially (capped) for unproductive fast exits — no reconnect storm", () => {
    expect(nextBackoff(1000, false)).toBe(2000);
    expect(nextBackoff(4000, false)).toBe(8000);
    expect(nextBackoff(15000, false)).toBe(15000); // capped
  });
});

describe("useContainerLogStream", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("appends streamed log lines and marks a one-shot stream ended on exit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body: streamFrom([frame({ chunk: "line-a" }), frame({ chunk: "line-b" }), frame({ exitCode: 0 })]),
      }) as Response),
    );

    const { result, unmount } = renderHook(() => useContainerLogStream("/apps/app1", { follow: false, active: true }));

    await waitFor(() => expect(result.current.ended).toBe(true));
    expect(result.current.lines).toEqual(["line-a", "line-b"]);
    expect(result.current.connected).toBe(false);
    unmount();
  });

  it("passes container + follow as query params", async () => {
    let url = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        url = u;
        return { ok: true, body: streamFrom([frame({ exitCode: 0 })]) } as Response;
      }),
    );
    const { unmount } = renderHook(() =>
      useContainerLogStream("/apps/app1", { container: "tugra_app1-web-1", follow: true, active: true }),
    );
    await waitFor(() => expect(url).toContain("/apps/app1/logs/stream"));
    expect(url).toContain("container=tugra_app1-web-1");
    expect(url).toContain("follow=1");
    unmount();
  });

  it("threads since/search/tail into the stream URL", async () => {
    let url = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        url = u;
        return { ok: true, body: streamFrom([frame({ exitCode: 0 })]) } as Response;
      }),
    );
    const { unmount } = renderHook(() =>
      useContainerLogStream("/apps/app1", { follow: true, active: true, since: "1h", search: "error", tail: 500 }),
    );
    await waitFor(() => expect(url).toContain("/apps/app1/logs/stream"));
    expect(url).toContain("since=1h");
    expect(url).toContain("search=error");
    expect(url).toContain("tail=500");
    unmount();
  });

  it("does not fetch when inactive", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useContainerLogStream("/apps/app1", { follow: true, active: false }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a non-2xx (403) as a failed connect — no lines, no hot-loop", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, body: streamFrom([frame({ chunk: "leak" })]) }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useContainerLogStream("/apps/app1", { follow: false, active: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.lines).toEqual([]); // the 403 body is never consumed
    unmount();
  });

  it("aborts the request on unmount", async () => {
    let captured: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        captured = init?.signal ?? undefined;
        return { ok: true, body: streamFrom([]) } as Response;
      }),
    );
    const { unmount } = renderHook(() => useContainerLogStream("/apps/app1", { follow: true, active: true }));
    await waitFor(() => expect(captured).toBeDefined());
    unmount();
    expect(captured!.aborted).toBe(true);
  });
});
