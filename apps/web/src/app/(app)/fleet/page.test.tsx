import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import { wallSeries } from "../../../lib/fleet-wall";
import { buildHeatmap, heatStep } from "../../../lib/fleet-heatmap";
import FleetPage from "./page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(cleanup);

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <FleetPage />
      </I18nProvider>
    </QueryClientProvider>,
  );

const srv = (id: string, name: string, status = "ONLINE") =>
  ({ id, name, status, teamId: "t1", clusterId: null, hostname: `${name}.example.com`, publicIp: null, publicIpv6: null, tags: [], uptimeSeconds: 1000, agentVersion: "1" }) as never;

const NOW = Date.now();
const sample = (cpu: number, mem: number) => ({ ts: NOW, cpu, memUsed: mem, memTotal: 100, diskUsed: 50, diskTotal: 100, netRx: 10, netTx: 10 });
const pts = (cpuBase: number, memBase: number) =>
  [0, 1, 2, 3].map((i) => ({ ts: NOW - (3 - i) * 60_000, cpu: cpuBase + i, mem: memBase + i }));

const latestSpy = () => vi.spyOn(api, "getFleetMetrics");
const trendSpy = () => vi.spyOn(api, "getFleetTrend");

beforeEach(() => {
  localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "listServers").mockResolvedValue([srv("a", "alpha"), srv("b", "bravo"), srv("c", "charlie")]);
  latestSpy().mockResolvedValue([
    { serverId: "a", sample: sample(10, 80) },
    { serverId: "b", sample: sample(90, 20) },
    { serverId: "c", sample: sample(50, 50) },
  ] as never);
  // c has NO trend row → placeholder in the wall
  trendSpy().mockResolvedValue([
    { serverId: "a", points: pts(10, 80) },
    { serverId: "b", points: pts(88, 20) },
  ]);
  vi.spyOn(api, "listClusters").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

const switchToWall = async () => {
  await waitFor(() => expect(screen.getByRole("button", { name: "Wall" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Wall" }));
};
const cardNames = () => screen.getAllByTestId("fleet-wall-card").map((c) => within(c).getByRole("link").textContent);

describe("FleetPage — Table | Wall switcher", () => {
  it("defaults to the Table view and toggles to the Wall and back, persisting the choice", async () => {
    wrap();
    await waitFor(() => expect(screen.getByRole("button", { name: "Table" }).getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(document.querySelector("table.fleet-table")).toBeTruthy());
    expect(screen.queryByTestId("fleet-wall-card")).toBeNull();

    await switchToWall();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    expect(document.querySelector("table.fleet-table")).toBeNull();
    expect(localStorage.getItem("tugra.fleetview")).toBe("wall");

    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(document.querySelector("table.fleet-table")).toBeTruthy());
    expect(screen.queryByTestId("fleet-wall-card")).toBeNull();
    expect(localStorage.getItem("tugra.fleetview")).toBe("table");
  });

  it("restores the persisted Wall view + metric on mount", async () => {
    localStorage.setItem("tugra.fleetview", "wall");
    localStorage.setItem("tugra.fleetwallmetric", "mem");
    wrap();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    expect(screen.getByRole("button", { name: "Memory" }).getAttribute("aria-pressed")).toBe("true");
    // hottest-first is aligned to the RESTORED metric (RAM 80, 50, 20), not the default CPU order
    await waitFor(() => expect(cardNames()).toEqual(["alpha", "charlie", "bravo"]));
    expect((screen.getByLabelText("Sort wall by") as HTMLSelectElement).value).toBe("hot");
  });

  it("switching to the Wall and back leaves the Table's own sort untouched", async () => {
    wrap();
    await waitFor(() => expect(document.querySelector("table.fleet-table")).toBeTruthy());
    const tableNames = () => Array.from(document.querySelectorAll("table.fleet-table tbody tr")).map((r) => r.textContent ?? "");
    const before = tableNames(); // default CPU desc: bravo, charlie, alpha
    expect(before[0]).toContain("bravo");
    await switchToWall();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Memory" })); // wall now RAM-hottest: alpha first
    await waitFor(() => expect(cardNames()[0]).toBe("alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(document.querySelector("table.fleet-table")).toBeTruthy());
    expect(tableNames()).toEqual(before);
  });

  it("each wall card has a single tab stop (the server link) and one value", async () => {
    wrap();
    await switchToWall();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    for (const card of screen.getAllByTestId("fleet-wall-card")) {
      expect(card.querySelector('[role="slider"]')).toBeNull();
      expect(card.querySelectorAll("[tabindex]")).toHaveLength(0);
      expect(within(card).getAllByRole("link")).toHaveLength(1);
    }
    const alpha = screen.getAllByTestId("fleet-wall-card").find((c) => within(c).queryByText("alpha"))!;
    expect(alpha.querySelector("svg path")).toBeTruthy(); // still drawn
    expect(within(alpha).getAllByTestId("fleet-wall-value")).toHaveLength(1);
    expect(alpha.textContent).not.toContain("100%"); // the chart's own axis-max tag + last-point header are gone
    expect(alpha.textContent!.match(/CPU/g)).toHaveLength(1); // the metric label is not repeated by the chart header
  });

  it("ignores a corrupt persisted value and falls back to Table", async () => {
    localStorage.setItem("tugra.fleetview", "bogus");
    wrap();
    await waitFor(() => expect(document.querySelector("table.fleet-table")).toBeTruthy());
  });
});

describe("FleetPage — wall cards", () => {
  it("renders one card per server: a chart where trend data exists, a placeholder where it does not", async () => {
    wrap();
    await switchToWall();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    const byName = (n: string) => screen.getAllByTestId("fleet-wall-card").find((c) => within(c).queryByText(n))!;
    // chart = an SVG path of the MetricChart; placeholder = no chart + the no-data text
    expect(byName("alpha").querySelector("svg path")).toBeTruthy();
    expect(byName("bravo").querySelector("svg path")).toBeTruthy();
    expect(within(byName("charlie")).getByText("No recent data")).toBeTruthy();
    expect(byName("charlie").querySelector("svg path")).toBeNull();
    // each card links to the server and shows the live value in text
    expect(within(byName("alpha")).getByRole("link").getAttribute("href")).toBe("/servers/a");
    expect(within(byName("bravo")).getByTestId("fleet-wall-value").textContent).toContain("90%");
  });

  it("the metric toggle changes what is plotted (CPU → RAM) and persists", async () => {
    wrap();
    await switchToWall();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    const bravo = () => screen.getAllByTestId("fleet-wall-card").find((c) => within(c).queryByText("bravo"))!;
    expect(within(bravo()).getByTestId("fleet-wall-value").textContent).toContain("90%");
    expect(bravo().textContent).toContain("CPU");

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await waitFor(() => expect(within(bravo()).getByTestId("fleet-wall-value").textContent).toContain("20%"));
    expect(bravo().textContent).toContain("Memory");
    expect(bravo().querySelector("svg path")).toBeTruthy();
    expect(localStorage.getItem("tugra.fleetwallmetric")).toBe("mem");

    // Disk has no per-server trend → live value + a clear note instead of a broken chart
    fireEvent.click(screen.getByRole("button", { name: "Disk" }));
    await waitFor(() => expect(within(bravo()).getByTestId("fleet-wall-value").textContent).toContain("50%"));
    expect(within(bravo()).getByText("No trend history for this metric yet.")).toBeTruthy();
  });

  it("is hottest-first by the selected metric, and re-orders when the metric changes", async () => {
    wrap();
    await switchToWall();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    expect(cardNames()).toEqual(["bravo", "charlie", "alpha"]); // CPU 90, 50, 10
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await waitFor(() => expect(cardNames()).toEqual(["alpha", "charlie", "bravo"])); // RAM 80, 50, 20
  });

  it("the wall sort control orders by name", async () => {
    wrap();
    await switchToWall();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("Sort wall by"), { target: { value: "name" } });
    await waitFor(() => expect(cardNames()).toEqual(["alpha", "bravo", "charlie"]));
  });

  it("the search + status filters still apply in wall mode", async () => {
    wrap();
    await switchToWall();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("Search name, host or IP…"), { target: { value: "brav" } });
    await waitFor(() => expect(cardNames()).toEqual(["bravo"]));
    fireEvent.change(screen.getByLabelText("Search name, host or IP…"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("No servers match this filter.")).toBeTruthy());
    expect(screen.queryByTestId("fleet-wall-card")).toBeNull();
  });
});

describe("FleetPage — no per-server fan-out", () => {
  it("makes exactly one /latest and one /trend call for the whole wall", async () => {
    const latest = latestSpy();
    const trend = trendSpy();
    wrap();
    await switchToWall();
    await waitFor(() => expect(screen.getAllByTestId("fleet-wall-card")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    fireEvent.click(screen.getByRole("button", { name: "Disk" }));
    expect(trend).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

const switchToHeatmap = async () => {
  await waitFor(() => expect(screen.getByRole("button", { name: "Heatmap" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Heatmap" }));
};
const heatRows = () => screen.getAllByTestId("fleet-heat-row");
const heatRow = (id: string) => heatRows().find((r) => r.getAttribute("data-server-id") === id)!;
const heatNames = () => heatRows().map((r) => within(r).getByRole("link").textContent);

describe("FleetPage — Heatmap view", () => {
  it("the switcher offers Heatmap and persists + restores it", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    expect(localStorage.getItem("tugra.fleetview")).toBe("heatmap");
    expect(screen.getByRole("button", { name: "Heatmap" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("table.fleet-table")).toBeNull();
    cleanup();
    wrap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
  });

  it("renders one row per server with a link, status dot and a cell per trend minute", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    const alpha = heatRow("a");
    expect(within(alpha).getByRole("link").getAttribute("href")).toBe("/servers/a");
    expect(within(alpha).getByRole("img", { name: "ONLINE" })).toBeTruthy();
    expect(within(alpha).getAllByTestId("fleet-heat-cell")).toHaveLength(4); // 4 per-minute points
    expect(screen.getByRole("img", { name: /Heatmap colour scale/ })).toBeTruthy(); // legend
  });

  it("renders a missing point / missing trend as a distinct empty cell, not the ramp's low colour", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    const charlie = within(heatRow("c")).getAllByTestId("fleet-heat-cell"); // no trend row at all
    expect(charlie).toHaveLength(4);
    for (const c of charlie) {
      expect(c.getAttribute("data-empty")).toBe("true");
      expect(c.className).toContain("fleet-heat-empty");
      expect(c.getAttribute("aria-label")).toContain("no data");
      expect((c as HTMLElement).style.background).toBe("");
    }
    for (const c of within(heatRow("a")).getAllByTestId("fleet-heat-cell")) expect(c.getAttribute("data-empty")).toBeNull();
  });

  it("every cell carries server + time + exact value as title and aria-label", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    const cells = within(heatRow("a")).getAllByTestId("fleet-heat-cell");
    const last = cells[cells.length - 1]; // alpha CPU: 10, 11, 12, 13
    expect(last.getAttribute("aria-label")).toMatch(/^alpha, .+: CPU 13%$/);
    expect(last.getAttribute("title")).toBe(last.getAttribute("aria-label"));
    expect(heatRow("a").getAttribute("aria-label")).toBe("alpha: latest 13%, peak 13%");
  });

  it("the metric toggle changes the mapped values and colour steps (CPU -> RAM)", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    const alphaCells = () => within(heatRow("a")).getAllByTestId("fleet-heat-cell");
    expect(alphaCells()[0].getAttribute("data-value")).toBe("10");
    expect(alphaCells()[0].getAttribute("data-step")).toBe(String(heatStep(10)));
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await waitFor(() => expect(alphaCells()[0].getAttribute("data-value")).toBe("80"));
    expect(alphaCells()[0].getAttribute("data-step")).toBe(String(heatStep(80)));
    expect(alphaCells()[0].getAttribute("aria-label")).toContain("Memory 80%");
    expect(localStorage.getItem("tugra.fleetwallmetric")).toBe("mem");
  });

  it("disk/net have no trend history -> a note instead of a grid", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Disk" }));
    await waitFor(() => expect(screen.getByTestId("fleet-heat-notrend")).toBeTruthy());
    expect(screen.getByText("No trend history for this metric yet.")).toBeTruthy();
    expect(screen.queryByTestId("fleet-heat-row")).toBeNull();
  });

  it("is hottest-first by the metric, re-sorts with it, and honours the sort control + search", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    expect(heatNames()).toEqual(["bravo", "charlie", "alpha"]); // CPU 90, 50, 10
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await waitFor(() => expect(heatNames()).toEqual(["alpha", "charlie", "bravo"]));
    fireEvent.change(screen.getByLabelText("Sort wall by"), { target: { value: "name" } });
    await waitFor(() => expect(heatNames()).toEqual(["alpha", "bravo", "charlie"]));
    fireEvent.change(screen.getByLabelText("Search name, host or IP…"), { target: { value: "brav" } });
    await waitFor(() => expect(heatNames()).toEqual(["bravo"]));
    fireEvent.change(screen.getByLabelText("Search name, host or IP…"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("No servers match this filter.")).toBeTruthy());
  });

  it("clicking a row's cells opens the server, and says how many servers are shown", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    expect(screen.getByTestId("fleet-heat-count").textContent).toBe("Showing 3 of 3 servers");
    fireEvent.click(within(heatRow("b")).getAllByTestId("fleet-heat-cell")[0]);
    expect(push).toHaveBeenCalledWith("/servers/b");
  });

  it("the name link is a normal link (no stretched overlay) so cells stay hoverable and clickable", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    const link = within(heatRow("a")).getByRole("link");
    expect(link.className).toContain("fleet-heat-name");
    expect(link.className).not.toContain("fleet-namelink");
  });

  it("shows a skeleton while the trend loads, then 'No recent data' only once loaded empty", async () => {
    let resolve!: (v: never[]) => void;
    trendSpy().mockReturnValue(new Promise<never[]>((r) => (resolve = r)) as never);
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(screen.getByTestId("fleet-heat-loading")).toBeTruthy());
    expect(screen.queryByText("No recent data")).toBeNull();
    resolve([]);
    await waitFor(() => expect(screen.getByText("No recent data")).toBeTruthy());
    expect(screen.queryByTestId("fleet-heat-loading")).toBeNull();
  });

  it("puts time-axis ticks on column centres", async () => {
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    const lefts = Array.from(document.querySelectorAll(".fleet-heat-axis > span")).map((e) => (e as HTMLElement).style.left);
    expect(lefts[0]).toBe("12.5%"); // 4 columns: first centre = 0.5/4
    expect(lefts[lefts.length - 1]).toBe("87.5%"); // last centre = 3.5/4
  });

  it("resets the row cap to one page when a filter changes", async () => {
    const many = Array.from({ length: 60 }, (_, i) => srv(`s${i}`, `srv${String(i).padStart(2, "0")}`));
    vi.spyOn(api, "listServers").mockResolvedValue(many);
    latestSpy().mockResolvedValue(many.map((m: never, i) => ({ serverId: (m as { id: string }).id, sample: sample(i, 10) })) as never);
    trendSpy().mockResolvedValue(many.map((m: never) => ({ serverId: (m as { id: string }).id, points: pts(10, 10) })));
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Show more servers" }));
    await waitFor(() => expect(heatRows()).toHaveLength(60));
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await waitFor(() => expect(heatRows()).toHaveLength(50));
  });

  it("makes exactly one /latest and one /trend call (no per-server fan-out)", async () => {
    const latest = latestSpy();
    const trend = trendSpy();
    wrap();
    await switchToHeatmap();
    await waitFor(() => expect(heatRows()).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    fireEvent.click(screen.getByRole("button", { name: "Disk" }));
    expect(trend).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

describe("buildHeatmap / heatStep", () => {
  const mk = (id: string) => ({ server: { id } }) as never;
  it("buckets by minute, leaves gaps null, and caps rows' columns to the newest window", () => {
    const m = 60_000;
    const base = 1_700_000_000_000 - (1_700_000_000_000 % m);
    const trends = new Map([
      ["a", { serverId: "a", points: [{ ts: base, cpu: 10, mem: 1 }, { ts: base + 2 * m + 5, cpu: 30, mem: 3 }] }],
      ["b", { serverId: "b", points: [{ ts: base + m, cpu: 20, mem: 2 }] }],
    ]);
    const h = buildHeatmap([mk("a"), mk("b"), mk("c")], trends, "cpu");
    expect(h.times).toEqual([base, base + m, base + 2 * m]);
    expect(h.rows.map((r) => r.cells)).toEqual([[10, null, 30], [null, 20, null], [null, null, null]]);
    expect(h.rows[0]).toMatchObject({ latest: 30, peak: 30 });
    expect(h.rows[2]).toMatchObject({ latest: null, peak: null });
    expect(buildHeatmap([mk("a"), mk("b")], trends, "cpu", 2).times).toEqual([base + m, base + 2 * m]);
    expect(buildHeatmap([mk("a")], trends, "disk").times).toEqual([]);
  });
  it("maps a fixed 0-100 domain onto 9 clamped steps", () => {
    expect([0, 10, 50, 99.9, 100, 150, -5].map(heatStep)).toEqual([0, 0, 4, 8, 8, 8, 0]);
  });
});

describe("wallSeries", () => {
  const row = { serverId: "a", points: [{ ts: 3, cpu: 30, mem: null }, { ts: 1, cpu: 10, mem: 40 }, { ts: 2, cpu: Number.NaN, mem: 50 }, { ts: 4, cpu: 40, mem: 60 }] };
  it("drops non-finite points, orders by time and picks the metric", () => {
    expect(wallSeries(row, "cpu")).toEqual({ values: [10, 30, 40], times: [1, 3, 4] });
    expect(wallSeries(row, "mem")).toEqual({ values: [40, 50, 60], times: [1, 2, 4] });
  });
  it("returns null with <2 usable points, no row, or a metric without a trend", () => {
    expect(wallSeries(undefined, "cpu")).toBeNull();
    expect(wallSeries({ serverId: "a", points: [{ ts: 1, cpu: 1, mem: 1 }] }, "cpu")).toBeNull();
    expect(wallSeries(row, "disk")).toBeNull();
    expect(wallSeries(row, "net")).toBeNull();
  });
});
