import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { reportHubDown } from "../lib/hub-connection";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ logout: () => {}, user: null }) }));

import { HubConnectionBanner, nextHubPingDelay, HUB_PING_BASE_MS, HUB_PING_MAX_MS } from "./shell";

let qc: QueryClient;
const mount = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <HubConnectionBanner />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("nextHubPingDelay", () => {
  it("backs off from 3s and caps at 15s", () => {
    expect(HUB_PING_BASE_MS).toBe(3000);
    expect(nextHubPingDelay(3000)).toBe(4500);
    expect(nextHubPingDelay(10_000)).toBe(HUB_PING_MAX_MS);
    expect(nextHubPingDelay(HUB_PING_MAX_MS)).toBe(HUB_PING_MAX_MS);
  });
});

describe("HubConnectionBanner", () => {
  const savedFetch = global.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    global.fetch = savedFetch;
  });

  it("is hidden until a request reports the hub down", () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    mount();
    expect(screen.queryByTestId("hub-connection-banner")).toBeNull();
  });

  it("shows on report, pings the public status with backoff, then hides and invalidates all queries", async () => {
    const calls: string[] = [];
    let up = false;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (!up) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    mount();

    act(() => reportHubDown());
    expect(screen.getByTestId("hub-connection-banner")).toBeTruthy();
    expect(screen.getByText(/Can't reach the Tugra hub/)).toBeTruthy();
    expect(calls).toHaveLength(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); // 1st ping fails
    expect(calls).toEqual(["/api/v1/instance/status"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); // backoff → next ping not yet due (4.5s)
    expect(calls).toHaveLength(1);
    up = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); // 2nd ping succeeds
    expect(calls).toHaveLength(2);
    expect(screen.queryByTestId("hub-connection-banner")).toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); // loop stopped
    expect(calls).toHaveLength(2);
  });

  it("treats a 502 answer as still down, and 'Retry now' pings immediately", async () => {
    global.fetch = vi.fn(async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    mount();
    act(() => reportHubDown());
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByTestId("hub-connection-banner")).toBeTruthy();
    const before = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
  });
});
