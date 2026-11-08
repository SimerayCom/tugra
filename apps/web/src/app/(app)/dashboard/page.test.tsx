import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import DashboardPage from "./page";
import { api } from "../../../lib/api";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const srv = (id: string, status: string) => ({ id, name: `srv-${id}`, status, teamId: "t1", hostname: null, tags: [] });
const sample = (cpu: number, disk = 40) => ({ ts: Date.now(), cpu, memUsed: 61, memTotal: 100, diskUsed: disk, diskTotal: 100, netRx: 0, netTx: 0, diskRead: 0, diskWrite: 0 });
const pts = (cpus: number[]) => cpus.map((cpu, i) => ({ ts: 60_000 * (i + 1), cpu, mem: 40 + i }));

// Past the loading skeleton: the status tiles (real links) only exist once the servers query resolved.
const ready = () => waitFor(() => expect(document.querySelector('a[href="/servers?status=ONLINE"]')).toBeTruthy());

function mockApi(o: { latest?: unknown[]; trend?: unknown[] } = {}) {
  vi.spyOn(api, "listServers").mockResolvedValue([srv("a", "ONLINE"), srv("b", "ONLINE"), srv("c", "OFFLINE"), srv("d", "PENDING")] as never);
  vi.spyOn(api, "listProjects").mockResolvedValue([]);
  vi.spyOn(api, "listApps").mockResolvedValue([]);
  vi.spyOn(api, "listDatabases").mockResolvedValue([]);
  vi.spyOn(api, "listMonitors").mockResolvedValue([]);
  vi.spyOn(api, "listDomains").mockResolvedValue([]);
  vi.spyOn(api, "listAudit").mockResolvedValue({ entries: [] } as never);
  vi.spyOn(api, "getFleetMetrics").mockResolvedValue((o.latest ?? []) as never);
  vi.spyOn(api, "getFleetTrend").mockResolvedValue((o.trend ?? []) as never);
}

describe("DashboardPage fleet cockpit", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders Attention before the fleet tiles and the resource blocks", async () => {
    mockApi();
    wrap(<DashboardPage />);
    await ready(); // past the loading skeleton
    const attention = screen.getByText("Needs attention");
    const fleet = screen.getByText("Fleet");
    const resources = screen.getByText("Resources");
    expect(attention.compareDocumentPosition(fleet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fleet.compareDocumentPosition(resources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the offline server surfaces in the Attention list
    expect(screen.getAllByText("srv-c").length).toBeGreaterThan(0);
  });

  it("makes Online / Pending / Offline real links into the filtered server list", async () => {
    mockApi();
    wrap(<DashboardPage />);
    await ready();
    const tile = (status: string) => document.querySelector(`a[href="/servers?status=${status}"]`) as HTMLElement;
    expect(within(tile("ONLINE")).getByText("Online")).toBeTruthy();
    expect(within(tile("PENDING")).getByText("Pending")).toBeTruthy();
    expect(within(tile("OFFLINE")).getByText("Offline")).toBeTruthy();
    expect(within(tile("ONLINE")).getByText("of 4 servers")).toBeTruthy();
  });

  it("shows fleet CPU/RAM tiles with sparklines + an honest window, disk pressure and the chart when data is present", async () => {
    mockApi({
      latest: [{ serverId: "a", sample: sample(20, 85) }, { serverId: "b", sample: sample(80, 40) }],
      trend: [
        { serverId: "a", points: pts([10, 20, 30]) },
        { serverId: "b", points: pts([50, 60, 70]) },
      ],
    });
    wrap(<DashboardPage />);
    expect(await screen.findByText("Fleet CPU")).toBeTruthy();
    expect(screen.getByText("Fleet RAM")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy(); // mean of 20 and 80
    expect(screen.getAllByText("last 30 min").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("img", { name: "Fleet CPU trend, last 30 min" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Fleet RAM trend, last 30 min" })).toBeTruthy();
    expect(screen.getByText("Disk pressure")).toBeTruthy();
    expect(screen.getAllByText("Fleet CPU & RAM").length).toBeGreaterThan(0);
  });

  it("shows a signed delta (visible sign + sr-only sentence) from the aggregate trend series when it rises", async () => {
    mockApi({
      latest: [{ serverId: "a", sample: sample(20) }, { serverId: "b", sample: sample(80) }],
      trend: [
        { serverId: "a", points: pts([10, 20, 30]) },
        { serverId: "b", points: pts([50, 60, 70]) },
      ],
    });
    wrap(<DashboardPage />);
    // aggregate cpu 30 -> 50 (+20 pts) and mem 40 -> 42 (+2 pts): last point minus first, not live snapshot minus first
    const cpuText = await screen.findByText("Up 20 pts over the last 30 min");
    expect(cpuText.className).toContain("sr-only");
    expect(cpuText.parentElement?.hasAttribute("aria-label")).toBe(false);
    expect(screen.getByText("Up 2 pts over the last 30 min").className).toContain("sr-only");
    expect(screen.getByText("+20")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.queryByText("Average of online servers")).toBeNull();
  });

  it("makes no false 30-min claim when the trend is absent: shows the average hint, no sparkline or delta", async () => {
    mockApi({ latest: [{ serverId: "a", sample: sample(20, 85) }, { serverId: "b", sample: sample(80, 40) }] });
    wrap(<DashboardPage />);
    expect(await screen.findByText("Fleet CPU")).toBeTruthy();
    expect(screen.getAllByText("Average of online servers").length).toBe(2);
    expect(screen.queryByText("last 30 min")).toBeNull();
    expect(screen.queryByText(/over the last 30 min/)).toBeNull();
    expect(screen.queryByRole("img", { name: /Fleet CPU trend/ })).toBeNull();
  });

  it("renders a flat trend as ±0 with the steady sentence for screen readers", async () => {
    mockApi({
      latest: [{ serverId: "a", sample: sample(30) }],
      trend: [{ serverId: "a", points: [{ ts: 60_000, cpu: 30, mem: 61 }, { ts: 120_000, cpu: 30.2, mem: 61 }] }],
    });
    wrap(<DashboardPage />);
    expect((await screen.findAllByText("Steady over the last 30 min")).length).toBe(2);
    expect(screen.getAllByText("±0").length).toBe(2);
  });

  it("keeps the Disk pressure tile informational (not a link) while status tiles stay links", async () => {
    mockApi({ latest: [{ serverId: "a", sample: sample(20, 85) }] });
    wrap(<DashboardPage />);
    const label = await screen.findByText("Disk pressure");
    expect(label.closest("a")).toBeNull();
    expect(document.querySelector('a[href="/servers?status=ONLINE"]')).toBeTruthy();
  });

  it("hides the live tiles, chart and busiest list when there is no metrics data", async () => {
    mockApi();
    wrap(<DashboardPage />);
    await ready();
    await waitFor(() => expect(api.getFleetMetrics).toHaveBeenCalled());
    expect(screen.queryByText("Fleet CPU")).toBeNull();
    expect(screen.queryByText("Fleet RAM")).toBeNull();
    expect(screen.queryByText("Disk pressure")).toBeNull();
    expect(screen.queryByText("Busiest servers")).toBeNull();
    expect(screen.queryByText("Fleet CPU & RAM")).toBeNull();
    expect(screen.queryByRole("img", { name: /Fleet CPU trend/ })).toBeNull();
  });

  it("lists the busiest servers by latest CPU, linking to each server", async () => {
    mockApi({ latest: [{ serverId: "a", sample: sample(20) }, { serverId: "b", sample: sample(80) }] });
    wrap(<DashboardPage />);
    const title = await screen.findByText("Busiest servers");
    const list = title.parentElement!;
    const links = within(list).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/servers/b", "/servers/a"]);
    expect(within(links[0]).getByText("80% CPU")).toBeTruthy();
  });
});
