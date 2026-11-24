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

const emptyInsights = { diskForecast: [], backups: { windowDays: 7, ok: 0, failed: 0, running: 0, recent: [] }, deploys: [] };

function mockApi(o: { latest?: unknown[]; trend?: unknown[]; servers?: unknown[]; projects?: unknown[]; apps?: unknown[]; databases?: unknown[]; teams?: unknown[]; audit?: unknown[]; insights?: unknown; domains?: unknown[] } = {}) {
  vi.spyOn(api, "listServers").mockResolvedValue((o.servers ?? [srv("a", "ONLINE"), srv("b", "ONLINE"), srv("c", "OFFLINE"), srv("d", "PENDING")]) as never);
  vi.spyOn(api, "listProjects").mockResolvedValue((o.projects ?? []) as never);
  vi.spyOn(api, "listApps").mockResolvedValue((o.apps ?? []) as never);
  vi.spyOn(api, "listDatabases").mockResolvedValue((o.databases ?? []) as never);
  vi.spyOn(api, "listMonitors").mockResolvedValue([]);
  vi.spyOn(api, "listDomains").mockResolvedValue((o.domains ?? []) as never);
  vi.spyOn(api, "listTeams").mockResolvedValue((o.teams ?? []) as never);
  vi.spyOn(api, "getDashboardInsights").mockResolvedValue((o.insights ?? emptyInsights) as never);
  vi.spyOn(api, "getInstanceVersion").mockResolvedValue({ current: "0.1.0-beta.27", channel: "beta", latest: null, updateAvailable: false } as never);
  vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
  vi.spyOn(api, "listAudit").mockResolvedValue({ entries: o.audit ?? [], nextCursor: null } as never);
  vi.spyOn(api, "getFleetMetrics").mockResolvedValue((o.latest ?? []) as never);
  vi.spyOn(api, "getFleetTrend").mockResolvedValue((o.trend ?? []) as never);
  vi.spyOn(api, "getFleetHottestContainers").mockResolvedValue([]);
}

describe("DashboardPage fleet cockpit", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    localStorage.clear();
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

  it("shows the fleet-wide Hottest containers card next to the cockpit", async () => {
    mockApi();
    vi.spyOn(api, "getFleetHottestContainers").mockResolvedValue([
      { serverId: "a", serverName: "srv-a", containerName: "web", label: "web", kind: "other", cpu: 42, memUsed: 1, memTotal: 2, memPct: 50, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0 },
    ]);
    wrap(<DashboardPage />);
    await ready();
    expect(await screen.findByRole("table", { name: "Hottest containers" })).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
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
    expect(screen.getAllByText("50%").length).toBeGreaterThanOrEqual(1); // mean of 20 and 80 (tile + chart legend value)
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

  it("keeps a stable layout: auto-fill grid (never auto-fit) and a reserved sparkline slot with or without trend data", async () => {
    mockApi({ latest: [{ serverId: "a", sample: sample(20, 85) }] }); // no trend
    wrap(<DashboardPage />);
    await screen.findByText("Fleet CPU");
    const grid = screen.getByTestId("fleet-grid");
    expect(grid.style.gridTemplateColumns).toContain("auto-fill");
    expect(grid.style.gridTemplateColumns).not.toContain("auto-fit");
    const slots = screen.getAllByTestId("spark-slot");
    expect(slots.length).toBe(2);
    for (const s of slots) {
      expect(s.style.width).toBe("72px");
      expect(s.style.height).toBe("28px"); // empty-trend state reserves the same box the sparkline fills
      expect(s.querySelector("svg")).toBeNull();
    }
  });

  it("renders the sparkline inside the same reserved slot once trend data is present", async () => {
    mockApi({
      latest: [{ serverId: "a", sample: sample(20, 85) }],
      trend: [{ serverId: "a", points: pts([10, 20, 30]) }],
    });
    wrap(<DashboardPage />);
    await screen.findByText("Fleet CPU");
    const slots = screen.getAllByTestId("spark-slot");
    expect(slots.length).toBe(2);
    for (const s of slots) {
      expect(s.style.width).toBe("72px");
      expect(s.style.height).toBe("28px");
      expect(s.querySelector("svg")).not.toBeNull();
    }
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

  it("keeps the live tiles as em-dash placeholders (hides only chart/busiest) when there is no metrics data", async () => {
    mockApi();
    wrap(<DashboardPage />);
    await ready();
    await waitFor(() => expect(api.getFleetMetrics).toHaveBeenCalled());
    expect(screen.getByText("Fleet CPU")).toBeTruthy();
    expect(screen.getByText("Fleet RAM")).toBeTruthy();
    expect(screen.getByText("Disk pressure")).toBeTruthy();
    expect(screen.queryByText("Busiest servers")).toBeNull();
    expect(screen.queryByText("Fleet CPU & RAM")).toBeNull();
    expect(screen.queryByRole("img", { name: /Fleet CPU trend/ })).toBeNull();
  });

  it("fleet row has no vertical jump: skeleton, empty and loaded tiles all share one min-height", async () => {
    const tileMinHeights = () =>
      Array.from(screen.getByTestId("fleet-grid").children).map((c) => (c.firstElementChild as HTMLElement).style.minHeight);

    // 1) loading skeleton (servers never resolve)
    mockApi();
    vi.spyOn(api, "listServers").mockReturnValue(new Promise(() => {}) as never);
    wrap(<DashboardPage />);
    const skel = screen.getAllByTestId("fleet-skeleton-tile").map((el) => el.style.minHeight);
    expect(skel.length).toBe(6);
    expect(new Set(skel).size).toBe(1);
    expect(skel[0]).toMatch(/^\d+px$/);
    cleanup();
    vi.restoreAllMocks();

    // 2) loaded, no metrics yet: all 6 tiles present (CPU/RAM/disk as placeholders), same height as the skeleton
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApi();
    wrap(<DashboardPage />);
    await ready();
    const empty = tileMinHeights();
    expect(empty.length).toBe(6);
    expect(new Set(empty).size).toBe(1);
    expect(empty[0]).toBe(skel[0]);
    cleanup();
    vi.restoreAllMocks();

    // 3) loaded with metrics + trend: unchanged
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockApi({ latest: [{ serverId: "a", sample: sample(20, 85) }], trend: [{ serverId: "a", points: pts([10, 20, 30]) }] });
    wrap(<DashboardPage />);
    await screen.findByText("20%");
    expect(tileMinHeights()).toEqual(empty);
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

const server = (i: number, status: string, hostname: string | null = null) => ({ id: `s${i}`, name: `node-${String(i).padStart(2, "0")}`, status, teamId: "t1", hostname, tags: [] });
const project = (id: string, teamId: string, name: string, isDefault: boolean, apps: number, createdAt = "2026-01-01T00:00:00Z") => ({
  id, teamId, name, isDefault, role: "OWNER", canWrite: true, iconUpdatedAt: null, createdAt,
  environments: [{ id: `${id}-e`, name: "production", isDefault: true, appCount: apps, dbCount: 0, createdAt }],
});

describe("DashboardPage lists, cards and customization", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("caps the server list at 6 rows with a 'See all (N)' link, problems first, and shows the real host name (never a container id)", async () => {
    const servers = [
      ...Array.from({ length: 9 }, (_, i) => server(i + 1, "ONLINE")),
      { ...server(10, "OFFLINE", "edge-1.example.com") },
      { ...server(11, "ONLINE", "7cefb92e6217") },
    ];
    mockApi({ servers });
    wrap(<DashboardPage />);
    const heading = await screen.findByRole("heading", { name: "Servers" });
    const card = heading.closest("section") as HTMLElement;
    const links = within(card).getAllByRole("link");
    const rows = links.filter((l) => /^\/servers\/s\d+$/.test(l.getAttribute("href") ?? ""));
    expect(rows).toHaveLength(6);
    expect(rows[0].getAttribute("href")).toBe("/servers/s10"); // the offline one leads
    expect(within(rows[0]).getByText("edge-1.example.com")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "See all (11) →" }).getAttribute("href")).toBe("/servers");
    // a leftover container id is not a host name
    expect(screen.queryByText("7cefb92e6217")).toBeNull();
  });

  it("shows team name per project, collapses empty default projects into one line, and orders projects by recent use", async () => {
    const teams = [{ id: "t1", name: "Acme", role: "OWNER" }, { id: "t2", name: "Beta", role: "OWNER" }, { id: "t3", name: "Gamma", role: "OWNER" }];
    mockApi({
      teams,
      projects: [
        project("old", "t1", "Old shop", false, 1, "2026-01-01T00:00:00Z"),
        project("fresh", "t2", "Fresh blog", false, 2, "2026-09-01T00:00:00Z"),
        project("d1", "t1", "Default", true, 0),
        project("d2", "t2", "Default", true, 0),
        project("d3", "t3", "Default", true, 0),
      ],
      apps: [{ id: "a1", projectId: "old", createdAt: "2026-01-01T00:00:00Z", teamId: "t1" }],
    });
    wrap(<DashboardPage />);
    const card = (await screen.findByRole("heading", { name: "Projects" })).closest("section") as HTMLElement;
    await within(card).findByText("Fresh blog");
    const names = within(card).getAllByRole("link").map((l) => l.textContent).filter((x) => x === "Old shop" || x === "Fresh blog");
    expect(names).toEqual(["Fresh blog", "Old shop"]);
    expect(within(card).getByText("Beta")).toBeTruthy(); // the owning team of Fresh blog
    expect(within(card).getByText("Acme")).toBeTruthy();
    expect(within(card).queryByText("Default")).toBeNull(); // no wall of identical "Default" cards
    expect(within(card).getByText("Empty default projects in 3 teams")).toBeTruthy();
  });

  it("offers Import from Coolify / Deploy your first app when there are no apps or databases", async () => {
    mockApi();
    wrap(<DashboardPage />);
    expect((await screen.findByRole("link", { name: "Import from Coolify" })).getAttribute("href")).toBe("/import");
    expect(screen.getByRole("link", { name: "Deploy your first app" }).getAttribute("href")).toBe("/resources/new");
  });

  it("does not show that call to action once something exists", async () => {
    mockApi({ apps: [{ id: "a1", projectId: null, createdAt: "2026-01-01T00:00:00Z", teamId: "t1" }] });
    wrap(<DashboardPage />);
    await ready();
    await waitFor(() => expect(api.listDatabases).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("link", { name: "Import from Coolify" })).toBeNull();
  });

  it("hides noisy automatic events behind 'Show system events', groups MCP calls, and writes sentences", async () => {
    const e = (id: string, action: string, createdAt: string, meta: unknown = null) => ({ id, actor: "dev@example.com", action, target: null, meta, createdAt });
    mockApi({
      audit: [
        e("1", "mcp.tools_call", "2026-11-24T10:05:00Z"),
        e("2", "mcp.tools_call", "2026-11-24T10:04:00Z"),
        e("3", "app.deploy", "2026-11-24T10:03:00Z", { name: "Shop" }),
        e("4", "server.gpus.refresh", "2026-11-24T10:02:00Z"),
        e("5", "auth.profile.update", "2026-11-24T10:01:00Z"),
      ],
    });
    wrap(<DashboardPage />);
    const card = (await screen.findByRole("heading", { name: "Recent activity" })).closest("section") as HTMLElement;
    expect(await within(card).findByText("dev@example.com deployed Shop.")).toBeTruthy();
    expect(within(card).getByText("MCP: 2 calls")).toBeTruthy();
    expect(within(card).getByText("2 automatic events")).toBeTruthy();
    expect(within(card).queryByText("GPU inventory refreshed.")).toBeNull();
    within(card).getByRole("button", { name: "Show system events" }).click();
    expect(await within(card).findByText("GPU inventory refreshed.")).toBeTruthy();
    expect(within(card).queryByText("MCP: 2 calls")).toBeNull();
    expect(within(card).getByRole("button", { name: "Hide system events" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders the new insight cards: disk forecast, backups, deploys, certificates", async () => {
    mockApi({
      insights: {
        diskForecast: [{ serverId: "a", serverName: "srv-a", usedPct: 71.5, freeBytes: 30_000_000_000, growthBytesPerDay: 2_000_000_000, daysToFull: 12.4 }],
        backups: { windowDays: 7, ok: 5, failed: 1, running: 0, recent: [{ id: "b1", kind: "database", resourceId: "d1", resourceName: "main-pg", status: "FAILED", createdAt: new Date().toISOString(), sizeBytes: null }] },
        deploys: [{ id: "x1", appId: "app1", appName: "Shop", status: "SUCCESS", trigger: "webhook", createdAt: new Date().toISOString(), durationMs: 41_000 }],
      },
      domains: [{ appId: "app9", domain: "shop.example.com", https: true, ssl: { state: "expiring", daysRemaining: 6, validTo: null, issuer: null } }],
    });
    wrap(<DashboardPage />);
    expect(await screen.findByText("srv-a full in ~12 days", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("5 done · 1 failed in the last 7 days")).toBeTruthy();
    expect(screen.getByRole("link", { name: /main-pg/ }).getAttribute("href")).toBe("/databases/d1");
    expect(screen.getByRole("link", { name: /Shop/ }).getAttribute("href")).toBe("/apps/app1");
    expect(screen.getAllByText("6 days left").length).toBeGreaterThan(0);
    expect(screen.getByText("Every agent is up to date.")).toBeTruthy();
  });

  it("lets the user hide and reorder cards, remembers it per user, and can reset", async () => {
    mockApi();
    wrap(<DashboardPage />);
    await ready();
    expect(screen.getByRole("heading", { name: "Recent deploys" })).toBeTruthy();
    screen.getByRole("button", { name: "Customize" }).click();
    const panel = (await screen.findByRole("heading", { name: "Customize dashboard" })).closest("section") as HTMLElement;
    within(panel).getByRole("checkbox", { name: "Show Recent deploys" }).click();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Recent deploys" })).toBeNull());
    expect(JSON.parse(localStorage.getItem("tugra.dashboardLayout.anon")!).hidden).toContain("deploys");

    const order = () => Array.from(document.querySelectorAll("section[data-card]")).map((el) => el.getAttribute("data-card"));
    const before = order();
    expect(before[0]).toBe("attention");
    within(panel).getByRole("button", { name: "Move Needs attention down" }).click();
    await waitFor(() => expect(order()[0]).not.toBe("attention"));
    expect(order().indexOf("attention")).toBeGreaterThan(0);

    within(panel).getByRole("button", { name: "Reset" }).click();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Recent deploys" })).toBeTruthy());
    expect(order()[0]).toBe("attention");
    expect(localStorage.getItem("tugra.dashboardLayout.anon")).toBeNull();
  });

  it("restores a saved layout on load and survives hiding every card", async () => {
    localStorage.setItem("tugra.dashboardLayout.anon", JSON.stringify({ order: ["activity", "servers"], hidden: ["fleet", "attention", "hottest", "diskForecast", "certs", "backups", "updates", "uptime", "deploys", "migrations", "resources", "projects", "servers", "activity"] }));
    mockApi();
    wrap(<DashboardPage />);
    expect(await screen.findByText("All cards are hidden. Open Customize to bring some back.")).toBeTruthy();
  });
});
