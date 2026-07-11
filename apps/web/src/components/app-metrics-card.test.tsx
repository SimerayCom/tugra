import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { AppMetricsCard } from "./app-metrics-card";
import { api } from "../lib/api";
import type { AppContainerMetrics, ContainerMetricSample } from "../lib/types";

afterEach(cleanup);

function sample(over: Partial<ContainerMetricSample> = {}): ContainerMetricSample {
  return { ts: 1000, cpu: 5, memUsed: 1, memTotal: 2, memPct: 50, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0, ...over };
}

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("AppMetricsCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders a section per container and queries the default 1h range", async () => {
    const data: AppContainerMetrics = {
      containers: [
        { name: "tugra_app1", samples: [sample(), sample({ ts: 2000, cpu: 9 })] },
        { name: "tugra_app1-web-1", samples: [sample()] },
      ],
    };
    const spy = vi.spyOn(api, "getAppContainerMetrics").mockResolvedValue(data);
    wrap(<AppMetricsCard id="app1" />);
    await waitFor(() => expect(screen.getByText("tugra_app1")).toBeTruthy());
    expect(screen.getByText("tugra_app1-web-1")).toBeTruthy();
    expect(spy).toHaveBeenCalledWith("app1", "1h");
  });

  it("switches range → refetches with the new range", async () => {
    const spy = vi.spyOn(api, "getAppContainerMetrics").mockResolvedValue({ containers: [] });
    wrap(<AppMetricsCard id="app1" />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("app1", "1h"));
    fireEvent.click(screen.getByText("24h"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("app1", "24h"));
  });

  it("shows an empty state when there are no containers", async () => {
    vi.spyOn(api, "getAppContainerMetrics").mockResolvedValue({ containers: [] });
    wrap(<AppMetricsCard id="app1" />);
    await waitFor(() =>
      expect(screen.getByText(/No metrics yet/)).toBeTruthy(),
    );
  });
});
