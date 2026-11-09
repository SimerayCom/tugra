import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import TrafficPage from "./page";
import { api } from "../../../lib/api";
import type { TrafficCountries, TrafficPaths, TrafficSummary } from "../../../lib/types";

afterEach(cleanup);

const T0 = 1_700_000_000_000;
const summary: TrafficSummary = {
  range: "24h",
  stepSec: 300,
  times: [T0, T0 + 300_000, T0 + 600_000],
  requests: [10, 20, 30],
  s2xx: [8, 15, 25],
  s3xx: [1, 2, 2],
  s4xx: [1, 2, 2],
  s5xx: [0, 1, 1],
  bytes: [1024, 2048, 4096],
  totals: { requests: 1000, s2xx: 48, s3xx: 5, s4xx: 5, s5xx: 2, bytes: 7168 },
};
const paths: TrafficPaths = {
  range: "24h",
  paths: [{ path: "/api/health", requests: 40, bytes: 2048 }, { path: "/login", requests: 20, bytes: 1024 }],
  other: { requests: 5, bytes: 100 },
};
// Geolocated requests only: sums to 100 while the summary total is 1000.
const countries: TrafficCountries = {
  range: "24h",
  countries: [{ country: "US", requests: 60 }, { country: "DE", requests: 30 }, { country: "ZZ", requests: 10 }],
};
const emptySummary: TrafficSummary = {
  ...summary, times: [], requests: [], s2xx: [], s3xx: [], s4xx: [], s5xx: [], bytes: [],
  totals: { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0 },
};

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <TrafficPage />
      </I18nProvider>
    </QueryClientProvider>,
  );

function mockApi(over: { summary?: TrafficSummary; paths?: TrafficPaths; countries?: TrafficCountries } = {}) {
  return {
    summary: vi.spyOn(api, "getTrafficSummary").mockResolvedValue(over.summary ?? summary),
    paths: vi.spyOn(api, "getTrafficPaths").mockResolvedValue(over.paths ?? paths),
    countries: vi.spyOn(api, "getTrafficCountries").mockResolvedValue(over.countries ?? countries),
    domains: vi.spyOn(api, "getTrafficDomains").mockResolvedValue([
      { domain: "a.example.com", appId: "app1", appName: "A", requests: 700 },
      { domain: "b.example.com", appId: null, appName: null, requests: 300 },
    ]),
  };
}

describe("TrafficPage", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders the charts, top paths and countries from the api (default 24h range)", async () => {
    const m = mockApi();
    wrap();
    await waitFor(() => expect(screen.getAllByText("Requests over time").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Status codes over time").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bandwidth").length).toBeGreaterThan(0);
    // honest label: a count per bucket, not a fake per-second rate
    expect(screen.getByText("Requests counted per time bucket (not a per-second rate).")).toBeTruthy();
    // the 4 explicit status series show up in the legend
    for (const l of ["2xx success", "3xx redirect", "4xx client error", "5xx server error"]) expect(screen.getByText(l)).toBeTruthy();
    // top paths
    expect(screen.getByText("/api/health")).toBeTruthy();
    expect(screen.getByText("/login")).toBeTruthy();
    expect(screen.getByText("Other (folded)")).toBeTruthy();
    // countries by NAME; ZZ is the "Other" overflow bucket, never a crash
    expect(screen.getByText("United States")).toBeTruthy();
    expect(screen.getByText("Germany")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
    // coverage: 90 located (ZZ excluded) of the 1,000 total, and the hub limit is raised past the default top set
    expect(screen.getByText("90 of 1,000 requests have a known country.")).toBeTruthy();
    expect(m.countries).toHaveBeenCalledWith(expect.objectContaining({ limit: 250 }));
    // totals tile
    expect(screen.getByText("1,000")).toBeTruthy();
    expect(m.summary).toHaveBeenCalledWith(expect.objectContaining({ range: "24h", domain: undefined }));
    expect(screen.queryByText("No traffic data yet")).toBeNull();
  });

  it("computes each country's percentage from the SUM of the countries, not the total request count", async () => {
    mockApi(); // summary total = 1000, countries sum = 100
    wrap();
    await waitFor(() => expect(screen.getAllByTestId("traffic-country")).toHaveLength(3));
    const rows = screen.getAllByTestId("traffic-country");
    // US: 60 / 100 = 60.0% (would read 6.0% if divided by the 1000 total)
    expect(within(rows[0]).getByText(/60 · 60\.0%/)).toBeTruthy();
    expect(within(rows[1]).getByText(/30 · 30\.0%/)).toBeTruthy();
    expect(within(rows[2]).getByText(/10 · 10\.0%/)).toBeTruthy();
    const bars = screen.getAllByTestId("traffic-country-bar");
    expect(bars.map((b) => (b as HTMLElement).style.width)).toEqual(["60%", "30%", "10%"]);
    // the section says it covers requests with a known country only
    expect(screen.getByText(/Share of requests with a known country/)).toBeTruthy();
  });

  it("shows a calm empty state (not an error) when there is no data", async () => {
    mockApi({ summary: emptySummary, paths: { range: "24h", paths: [], other: { requests: 0, bytes: 0 } }, countries: { range: "24h", countries: [] } });
    wrap();
    await waitFor(() => expect(screen.getByText("No traffic data yet")).toBeTruthy());
    expect(screen.getByText(/Traffic Analytics may be turned off/)).toBeTruthy();
    expect(screen.getByText("Go to Servers").getAttribute("href")).toBe("/servers");
    expect(screen.queryAllByText("Requests over time")).toHaveLength(0);
  });

  it("shows an error state with retry when every request fails", async () => {
    vi.spyOn(api, "getTrafficDomains").mockResolvedValue([]);
    vi.spyOn(api, "getTrafficSummary").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "getTrafficPaths").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "getTrafficCountries").mockRejectedValue(new Error("boom"));
    wrap();
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
    expect(screen.queryByText("No traffic data yet")).toBeNull();
  });

  it("switches range and domain → refetches with them", async () => {
    const m = mockApi();
    wrap();
    await waitFor(() => expect(m.summary).toHaveBeenCalledWith(expect.objectContaining({ range: "24h" })));
    fireEvent.click(screen.getByText("7d"));
    await waitFor(() => expect(m.summary).toHaveBeenCalledWith(expect.objectContaining({ range: "7d" })));
    await waitFor(() => expect(screen.getByRole("option", { name: "a.example.com (700)" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "a.example.com" } });
    await waitFor(() => expect(m.paths).toHaveBeenCalledWith(expect.objectContaining({ range: "7d", domain: "a.example.com" })));
    expect(m.countries).toHaveBeenCalledWith(expect.objectContaining({ domain: "a.example.com" }));
  });
});
