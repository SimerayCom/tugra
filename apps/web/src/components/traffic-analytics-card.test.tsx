import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { TrafficAnalyticsCard } from "./traffic-analytics-card";
import { api } from "../lib/api";
import { subscribeToast } from "../lib/toast-bus";
import type { TrafficAnalyticsState } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
let toasts: { message: string; type: string }[];
let unsub: () => void;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  toasts = [];
  unsub = subscribeToast((x) => toasts.push({ message: x.message, type: x.type }));
});
afterEach(() => {
  unsub();
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
const state = (over: Partial<TrafficAnalyticsState>): TrafficAnalyticsState => ({ trafficAnalytics: true, apply: "applied", applyError: null, ...over });

describe("TrafficAnalyticsCard", () => {
  it("shows the privacy note and calls the endpoint when a writer enables it", async () => {
    const set = vi.spyOn(api, "setServerTrafficAnalytics").mockResolvedValue(state({}));
    wrap(<TrafficAnalyticsCard id="s1" enabled={false} canWrite />);
    expect(screen.getByText(/nothing is sent to any third party/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Enable traffic analytics"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("s1", true));
    await waitFor(() => expect(toasts).toEqual([{ message: "Traffic analytics enabled", type: "success" }]));
  });

  it("sends enabled=false when turning it off", async () => {
    const set = vi.spyOn(api, "setServerTrafficAnalytics").mockResolvedValue(state({ trafficAnalytics: false }));
    wrap(<TrafficAnalyticsCard id="s1" enabled canWrite />);
    expect((screen.getByLabelText("Enable traffic analytics") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Enable traffic analytics"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("s1", false));
    await waitFor(() => expect(toasts[0]?.message).toBe("Traffic analytics disabled"));
  });

  it.each([
    [state({ apply: "deferred" }), "Traffic analytics saved; applies on next proxy start", "info"],
    [state({ apply: "failed", applyError: "traefik down" }), "Traffic analytics saved, but re-applying the proxy failed: traefik down", "error"],
    [state({ apply: "failed" }), "Traffic analytics saved, but re-applying the proxy failed", "error"],
    [state({ apply: "not-in-pool" }), "Traffic analytics saved; this server is not in the proxy pool yet", "info"],
    [state({ apply: "cluster-shared" }), "Traffic analytics saved; the cluster's shared ingress applies it", "info"],
  ])("surfaces the apply state %#", async (res, message, type) => {
    vi.spyOn(api, "setServerTrafficAnalytics").mockResolvedValue(res);
    wrap(<TrafficAnalyticsCard id="s1" enabled={false} canWrite />);
    fireEvent.click(screen.getByLabelText("Enable traffic analytics"));
    await waitFor(() => expect(toasts).toEqual([{ message, type }]));
  });

  it("toasts an error when the request fails", async () => {
    vi.spyOn(api, "setServerTrafficAnalytics").mockRejectedValue(new Error("nope"));
    wrap(<TrafficAnalyticsCard id="s1" enabled={false} canWrite />);
    fireEvent.click(screen.getByLabelText("Enable traffic analytics"));
    await waitFor(() => expect(toasts).toEqual([{ message: "Could not change traffic analytics: nope", type: "error" }]));
  });

  it("is read-only for a viewer: disabled, never calls the endpoint", () => {
    const set = vi.spyOn(api, "setServerTrafficAnalytics").mockResolvedValue(state({}));
    wrap(<TrafficAnalyticsCard id="s1" enabled canWrite={false} />);
    const box = screen.getByLabelText("Enable traffic analytics") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(set).not.toHaveBeenCalled();
    expect(screen.getByText("You have read-only access to this server.")).toBeTruthy();
  });
});
