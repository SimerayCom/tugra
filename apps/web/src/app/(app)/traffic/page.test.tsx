import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import TrafficPage from "./page";
import { api } from "../../../lib/api";
import type { TrafficBreakdown, TrafficCountries, TrafficPaths, TrafficSummary } from "../../../lib/types";

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
  p95Ms: [120, 0, 340],
  uniqueVisitors: [40, 0, 90],
  totals: { requests: 1000, s2xx: 48, s3xx: 5, s4xx: 5, s5xx: 2, bytes: 7168, botRequests: 250, humanRequests: 650, p95Ms: 230, uniqueVisitors: 1234 },
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
  ...summary, times: [], requests: [], s2xx: [], s3xx: [], s4xx: [], s5xx: [], bytes: [], p95Ms: [], uniqueVisitors: [],
  totals: { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0, botRequests: 0, humanRequests: 0, p95Ms: 0, uniqueVisitors: 0 },
};

const breakdownBrowser: TrafficBreakdown = {
  range: "24h", dim: "browser",
  items: [{ key: "Chrome", requests: 60 }, { key: "Firefox", requests: 20 }],
  other: { requests: 20 },
};
const breakdownReferrer: TrafficBreakdown = {
  range: "24h", dim: "referrer",
  items: [{ key: "(direct)", requests: 30 }, { key: "news.example.org", requests: 10 }],
  other: { requests: 0 },
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

function mockApi(over: { summary?: TrafficSummary; paths?: TrafficPaths; countries?: TrafficCountries; breakdown?: (dim: string) => TrafficBreakdown } = {}) {
  const bd = over.breakdown ?? ((dim: string) => (dim === "referrer" ? breakdownReferrer : dim === "browser" ? breakdownBrowser : { range: "24h", dim, items: [], other: { requests: 0 } } as unknown as TrafficBreakdown));
  return {
    breakdown: vi.spyOn(api, "getTrafficBreakdown").mockImplementation(async (dim) => bd(dim)),
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

  it("credits DB-IP for the geolocation data with a link (CC-BY attribution)", async () => {
    mockApi();
    wrap();
    const link = await screen.findByText("IP geolocation by DB-IP");
    expect(link.closest("a")?.getAttribute("href")).toBe("https://db-ip.com");
    expect(link.closest("a")?.getAttribute("rel")).toContain("noopener");
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

  it("draws the world map beside the countries list (list stays the accessible data) and omits it with no country data", async () => {
    mockApi();
    wrap();
    const map = await screen.findByTestId("world-map");
    expect(map.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(map.querySelector('[data-country="US"]')!.getAttribute("data-bin")).toBe("5");
    expect(screen.getByRole("region", { name: "Countries list" })).toBeTruthy();
    cleanup();
    qc.clear();
    mockApi({ countries: { range: "24h", countries: [] } });
    wrap();
    expect(await screen.findByText("No country data in this range.")).toBeTruthy();
    expect(screen.queryByTestId("world-map")).toBeNull();
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

  it("renders the p95 tile (ms) and the bot tile (bot share of classified requests)", async () => {
    mockApi();
    wrap();
    await waitFor(() => expect(screen.getByText("p95 latency")).toBeTruthy());
    expect(screen.getByText("230 ms")).toBeTruthy();
    // 250 bot / (250 bot + 650 human) = 27.8% (not 25% of the 1,000 total)
    expect(screen.getByText("27.8%")).toBeTruthy();
    expect(screen.getByText("650 human · 250 bot")).toBeTruthy();
    // p95 over time chart is present with honest labeling
    expect(screen.getAllByText("p95 latency over time").length).toBeGreaterThan(0);
  });

  it("renders the unique-visitors tile from totals.uniqueVisitors (the merged range estimate, not the sum of buckets)", async () => {
    mockApi();
    wrap();
    await waitFor(() => expect(screen.getByText("Unique visitors")).toBeTruthy());
    expect(screen.getByText("1,234")).toBeTruthy(); // totals.uniqueVisitors; 40 + 90 would be wrong
    expect(screen.queryByText("130")).toBeNull();
  });

  it("unique tile shows a calm placeholder when there are no visitors or the hub predates the field (never NaN)", async () => {
    const { uniqueVisitors: _drop, ...older } = summary;
    mockApi({ summary: { ...older, totals: { ...summary.totals, uniqueVisitors: undefined } } as TrafficSummary });
    wrap();
    await waitFor(() => expect(screen.getByText("Unique visitors")).toBeTruthy());
    expect(screen.getAllByText("No data").length).toBeGreaterThan(0);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("guards the zero cases: no latency data and no classified requests render calm placeholders, never NaN", async () => {
    mockApi({ summary: { ...summary, p95Ms: [0, 0, 0], totals: { ...summary.totals, p95Ms: 0, botRequests: 0, humanRequests: 0 } } });
    wrap();
    await waitFor(() => expect(screen.getByText("No data")).toBeTruthy());
    expect(screen.getByText("No classified requests")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryAllByText("p95 latency over time")).toHaveLength(0);
  });

  it("shows 0.0% bots (not a placeholder) when only human requests were classified", async () => {
    mockApi({ summary: { ...summary, totals: { ...summary.totals, botRequests: 0, humanRequests: 40 } } });
    wrap();
    await waitFor(() => expect(screen.getByText("0.0%", { selector: ".mono" })).toBeTruthy());
    expect(screen.getByText("40 human · 0 bot")).toBeTruthy();
  });

  it("renders the browser breakdown by default with shares over items + (other)", async () => {
    const m = mockApi();
    wrap();
    await waitFor(() => expect(screen.getAllByTestId("traffic-breakdown-row")).toHaveLength(3));
    expect(m.breakdown).toHaveBeenCalledWith("browser", expect.objectContaining({ range: "24h", domain: undefined, limit: 20 }));
    const rows = screen.getAllByTestId("traffic-breakdown-row");
    // denominator = 60 + 20 + other 20 = 100
    expect(within(rows[0]).getByText("Chrome")).toBeTruthy();
    expect(within(rows[0]).getByText(/60 · 60\.0%/)).toBeTruthy();
    expect(within(rows[1]).getByText(/20 · 20\.0%/)).toBeTruthy();
    expect(within(rows[2]).getByText("Everything else")).toBeTruthy();
    expect(within(rows[2]).getByText(/20 · 20\.0%/)).toBeTruthy();
    expect(screen.getAllByTestId("traffic-breakdown-bar").map((b) => (b as HTMLElement).style.width)).toEqual(["60%", "20%", "20%"]);
  });

  it("switches dimension, refetches it with the page filters and localizes (direct)", async () => {
    const m = mockApi();
    wrap();
    await waitFor(() => expect(screen.getAllByTestId("traffic-breakdown-row")).toHaveLength(3));
    const group = screen.getByRole("group", { name: "Breakdown dimension" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Browser", "OS", "Device", "Referrer", "City", "Network"]);
    fireEvent.click(within(group).getByText("Referrer"));
    await waitFor(() => expect(m.breakdown).toHaveBeenCalledWith("referrer", expect.objectContaining({ range: "24h" })));
    await waitFor(() => expect(screen.getByText("Direct")).toBeTruthy());
    expect(screen.getByText("news.example.org")).toBeTruthy();
    // 30 / (30 + 10 + 0 other) = 75%; no (other) row when it is zero
    expect(screen.getByText(/30 · 75\.0%/)).toBeTruthy();
    expect(screen.getAllByTestId("traffic-breakdown-row")).toHaveLength(2);
    // range + domain filters flow through to the breakdown
    fireEvent.click(screen.getByText("7d"));
    await waitFor(() => expect(m.breakdown).toHaveBeenCalledWith("referrer", expect.objectContaining({ range: "7d" })));
    await waitFor(() => expect(screen.getByRole("option", { name: "a.example.com (700)" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "a.example.com" } });
    await waitFor(() => expect(m.breakdown).toHaveBeenCalledWith("referrer", expect.objectContaining({ range: "7d", domain: "a.example.com" })));
  });

  it("localizes the agent's raw device labels and the literal Other without clashing with the folded row", async () => {
    mockApi({
      breakdown: (dim) =>
        (dim === "device"
          ? { range: "24h", dim, items: [{ key: "desktop", requests: 50 }, { key: "mobile", requests: 30 }, { key: "tablet", requests: 8 }, { key: "bot", requests: 5 }, { key: "other", requests: 2 }], other: { requests: 5 } }
          : { range: "24h", dim, items: [{ key: "Chrome", requests: 60 }, { key: "Other", requests: 10 }], other: { requests: 5 } }) as unknown as TrafficBreakdown,
    });
    wrap();
    await waitFor(() => expect(screen.getAllByTestId("traffic-breakdown-row")).toHaveLength(3));
    // browser: the agent's literal "Other" and the synthetic overflow row read differently
    const bRows = screen.getAllByTestId("traffic-breakdown-row");
    expect(within(bRows[1]).getByText("Other")).toBeTruthy();
    expect(within(bRows[2]).getByText("Everything else")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Breakdown dimension" })).getByText("Device"));
    await waitFor(() => expect(screen.getAllByTestId("traffic-breakdown-row")).toHaveLength(6));
    const labels = screen.getAllByTestId("traffic-breakdown-row").map((r) => r.querySelector("span")!.textContent);
    expect(labels).toEqual(["Desktop", "Mobile", "Tablet", "Bot", "Other device", "Everything else"]);
  });

  it("makes the scrollable lists keyboard-focusable named regions", async () => {
    mockApi();
    wrap();
    await waitFor(() => expect(screen.getAllByTestId("traffic-breakdown-row")).toHaveLength(3));
    const lists = [screen.getByRole("region", { name: "Countries list" }), screen.getByRole("region", { name: "Visitor breakdown: Browser" })];
    for (const l of lists) expect(l.getAttribute("tabindex")).toBe("0");
  });

  it("gives every chart a View as table toggle that reveals the series as a table", async () => {
    mockApi();
    wrap();
    await waitFor(() => expect(screen.getAllByText("Requests over time").length).toBeGreaterThan(0));
    const toggles = screen.getAllByRole("button", { name: /^View as table:/ });
    expect(toggles.length).toBe(4);
    expect(screen.queryAllByTestId("chart-table")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "View as table: Status codes over time" }));
    expect(screen.getAllByTestId("chart-table")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "View as table: Status codes over time" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a calm empty note for a dimension with no data", async () => {
    mockApi();
    wrap();
    await waitFor(() => expect(screen.getAllByTestId("traffic-breakdown-row").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getByRole("group", { name: "Breakdown dimension" })).getByText("City"));
    await waitFor(() => expect(screen.getByText("No city data in this range.")).toBeTruthy());
    expect(screen.queryAllByTestId("traffic-breakdown-row")).toHaveLength(0);
  });

  it("an only-(other) dimension still renders its single honest 100% row", async () => {
    mockApi({ breakdown: () => ({ range: "24h", dim: "browser", items: [], other: { requests: 7 } }) });
    wrap();
    await waitFor(() => expect(screen.getAllByTestId("traffic-breakdown-row")).toHaveLength(1));
    expect(screen.getByText(/7 · 100\.0%/)).toBeTruthy();
  });

  it("a failing breakdown shows a retry in its card without breaking the rest of the page", async () => {
    mockApi();
    vi.spyOn(api, "getTrafficBreakdown").mockRejectedValue(new Error("boom"));
    wrap();
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
    expect(screen.getByText("/api/health")).toBeTruthy();
  });
});
