import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import type { AppLink, Application, ServerView, TrafficAnalyticsState, TrafficBreakdown, TrafficCountries, TrafficPaths, TrafficSummary } from "../../../../lib/types";
import { AnalyticsTab } from "./app-detail-analytics-tab";

afterEach(cleanup);

const T0 = 1_700_000_000_000;
const summary: TrafficSummary = {
  range: "24h", stepSec: 300, times: [T0, T0 + 300_000], requests: [10, 20], s2xx: [10, 20], s3xx: [0, 0], s4xx: [0, 0], s5xx: [0, 0], bytes: [1024, 2048],
  p95Ms: [120, 340], uniqueVisitors: [4, 9],
  totals: { requests: 30, s2xx: 30, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 3072, botRequests: 0, humanRequests: 30, p95Ms: 230, uniqueVisitors: 12 },
};
const emptySummary: TrafficSummary = {
  ...summary, times: [], requests: [], s2xx: [], s3xx: [], s4xx: [], s5xx: [], bytes: [], p95Ms: [], uniqueVisitors: [],
  totals: { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0, botRequests: 0, humanRequests: 0, p95Ms: 0, uniqueVisitors: 0 },
};
const paths: TrafficPaths = { range: "24h", paths: [{ path: "/home", requests: 30, bytes: 3072 }], other: { requests: 0, bytes: 0 } };
const emptyPaths: TrafficPaths = { range: "24h", paths: [], other: { requests: 0, bytes: 0 } };
const countries: TrafficCountries = { range: "24h", countries: [{ country: "TR", requests: 30 }] };
const emptyCountries: TrafficCountries = { range: "24h", countries: [] };
const breakdown: TrafficBreakdown = { range: "24h", dim: "browser", items: [{ key: "Chrome", requests: 30 }], other: { requests: 0 } };

const LINKS: AppLink[] = [
  { kind: "primary", url: "https://shop.example.com", host: "shop.example.com", label: null },
  { kind: "alias", url: "https://alias.example.com", host: "alias.example.com", label: null },
  { kind: "port", url: "http://203.0.113.7:8080", host: null, label: "web:80" },
];
const makeApp = (over: Partial<Application> = {}) => ({ id: "app1", teamId: "t1", serverId: "s1", clusterId: null, links: LINKS, ...over }) as unknown as Application;
const server = (over: Partial<ServerView> = {}) => ({ id: "s1", name: "prod", trafficAnalytics: true, canWrite: true, ...over }) as unknown as ServerView;

let qc: QueryClient;
const show = (app: Application) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <AnalyticsTab app={app} />
      </I18nProvider>
    </QueryClientProvider>,
  );

function mockApi(over: { server?: ServerView; summary?: TrafficSummary; paths?: TrafficPaths; countries?: TrafficCountries } = {}) {
  return {
    server: vi.spyOn(api, "getServer").mockResolvedValue(over.server ?? server()),
    summary: vi.spyOn(api, "getTrafficSummary").mockResolvedValue(over.summary ?? summary),
    paths: vi.spyOn(api, "getTrafficPaths").mockResolvedValue(over.paths ?? paths),
    countries: vi.spyOn(api, "getTrafficCountries").mockResolvedValue(over.countries ?? countries),
    breakdown: vi.spyOn(api, "getTrafficBreakdown").mockResolvedValue(breakdown),
    toggle: vi.spyOn(api, "setServerTrafficAnalytics").mockResolvedValue({ trafficAnalytics: true, apply: "applied", applyError: null } as TrafficAnalyticsState),
  };
}

describe("AnalyticsTab", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("scopes every panel request to the app (appId) and renders the panels", async () => {
    const m = mockApi();
    show(makeApp());
    await waitFor(() => expect(screen.getByText("Chrome")).toBeTruthy());
    for (const spy of [m.summary, m.paths, m.countries]) expect(spy).toHaveBeenCalledWith(expect.objectContaining({ appId: "app1", teamId: "t1" }));
    expect(m.breakdown).toHaveBeenCalledWith("browser", expect.objectContaining({ appId: "app1", teamId: "t1" }));
    expect(m.summary.mock.calls[0][0]?.domain).toBeUndefined();
    expect(screen.getByText("/home")).toBeTruthy();
  });

  it("the host picker lists the app's hosts only (no raw IP:port) and passes the chosen one as domain", async () => {
    const m = mockApi();
    show(makeApp());
    const select = (await screen.findByLabelText("Domain")) as HTMLSelectElement;
    const labels = Array.from(select.options).filter((o) => !o.disabled).map((o) => o.textContent);
    expect(labels).toEqual(["All app domains", "shop.example.com", "alias.example.com"]);
    fireEvent.change(select, { target: { value: "alias.example.com" } });
    await waitFor(() => expect(m.summary).toHaveBeenCalledWith(expect.objectContaining({ appId: "app1", domain: "alias.example.com" })));
  });

  it("empty state 1: an app with no host explains it and requests nothing", async () => {
    const m = mockApi();
    show(makeApp({ links: [LINKS[2]] }));
    expect(await screen.findByText(/has no domain/)).toBeTruthy();
    expect(m.summary).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Domain")).toBeNull();
  });

  it("empty state 2: analytics off on the server shows a one-click enable for that server only (writer)", async () => {
    const m = mockApi({ server: server({ trafficAnalytics: false }) });
    show(makeApp());
    const btn = await screen.findByRole("button", { name: "Enable Traffic Analytics on prod" });
    expect(m.summary).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(m.toggle).toHaveBeenCalledWith("s1", true));
  });

  it("empty state 2: a read-only viewer gets a note, not a button", async () => {
    mockApi({ server: server({ trafficAnalytics: false, canWrite: false }) });
    show(makeApp());
    expect(await screen.findByText(/An owner or admin of the server can turn it on/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Enable Traffic Analytics/ })).toBeNull();
  });

  it("empty state 3: a clustered app carries the own-server note", async () => {
    mockApi({ server: server({ trafficAnalytics: false, canWrite: false }) });
    show(makeApp({ clusterId: "c1" }));
    expect(await screen.findByText(/runs in a cluster/)).toBeTruthy();
    cleanup();
    mockApi();
    show(makeApp({ clusterId: "c1" }));
    await waitFor(() => expect(screen.getByText("Chrome")).toBeTruthy());
    expect(screen.getByText(/runs in a cluster/)).toBeTruthy();
  });

  it("empty state 4: enabled but nothing recorded says so", async () => {
    mockApi({ summary: emptySummary, paths: emptyPaths, countries: emptyCountries });
    show(makeApp());
    expect(await screen.findByText(/No visitor requests recorded for this app yet/)).toBeTruthy();
  });
});
