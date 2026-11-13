import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useServerReconnect } from "./useServerReconnect";
import type { ServerStatus } from "../lib/types";

afterEach(cleanup);
let qc: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
});
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

const run = (id = "s1") => renderHook(({ status }: { status: ServerStatus | undefined }) => useServerReconnect(id, status), { wrapper, initialProps: { status: undefined as ServerStatus | undefined } });

describe("useServerReconnect", () => {
  it("invalidates the server's child queries on a non-ONLINE → ONLINE edge (and not ['server', id])", () => {
    const { rerender } = run("s1");
    rerender({ status: "OFFLINE" });
    expect(invalidate).not.toHaveBeenCalled(); // no edge yet
    rerender({ status: "ONLINE" }); // the reconnect edge
    expect(invalidate).toHaveBeenCalledTimes(1);
    const pred = (invalidate.mock.calls[0][0] as { predicate: (q: { queryKey: unknown }) => boolean }).predicate;
    expect(pred({ queryKey: ["proxy", "s1"] })).toBe(true);
    expect(pred({ queryKey: ["server-disk-usage", "s1"] })).toBe(true);
    expect(pred({ queryKey: ["server", "s1"] })).toBe(false); // ['server', id] already polls — excluded
    expect(pred({ queryKey: ["proxy", "other"] })).toBe(false); // another server — untouched
  });

  it("does NOT invalidate on first render, on ONLINE→ONLINE, or on ONLINE→OFFLINE", () => {
    const { rerender } = run();
    rerender({ status: "ONLINE" }); // first time we see a status — no prior edge
    rerender({ status: "ONLINE" }); // steady state
    rerender({ status: "OFFLINE" }); // going down is not a recovery
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates again on a second OFFLINE → ONLINE cycle", () => {
    const { rerender } = run();
    rerender({ status: "ONLINE" });
    rerender({ status: "OFFLINE" });
    rerender({ status: "ONLINE" });
    expect(invalidate).toHaveBeenCalledTimes(1);
    rerender({ status: "OFFLINE" });
    rerender({ status: "ONLINE" });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
