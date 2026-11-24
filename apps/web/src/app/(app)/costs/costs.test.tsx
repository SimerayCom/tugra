import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ConfirmProvider } from "../../../components/confirm";
import { ToastProvider } from "../../../components/toast";
import CostsPage from "./page";
import { api } from "../../../lib/api";
import type { AdviceReport, CostsReport, ServerAdvice, ServerCostView, TeamCost } from "../../../lib/costs";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const server = (o: Partial<ServerCostView> = {}): ServerCostView => ({
  serverId: "s1",
  name: "web-1",
  monthlyCents: 599,
  currency: "EUR",
  source: "estimate",
  provider: "hetzner",
  planSlug: "cx23",
  planLabel: "CX23 · 2 vCPU · 4 GB · 40 GB",
  estimateBasis: "list",
  snapshotVerified: true,
  syncedAt: null,
  canSync: false,
  cores: 2,
  memBytes: 4 * 1024 ** 3,
  diskBytes: 40 * 1024 ** 3,
  apps: [],
  ...o,
});

const team = (o: Partial<TeamCost> = {}): TeamCost => ({
  teamId: "t1",
  teamName: "Acme",
  canManage: true,
  canOps: true,
  totals: [{ currency: "EUR", monthlyCents: 599, estimatedCents: 599, servers: 1 }],
  servers: [server()],
  baselines: [],
  comparison: null,
  snapshotDate: "2026-11-24",
  ...o,
});

const advice = (o: Partial<ServerAdvice> = {}): ServerAdvice => ({
  serverId: "s1",
  name: "web-1",
  teamId: "t1",
  kind: "downsize",
  reasons: [],
  daysCollected: 20,
  daysNeeded: 14,
  usage: { cpuAvgPct: 4, cpuP95Pct: 10, memP95Pct: 20, diskUsedPct: 30 },
  provider: "hetzner",
  current: { slug: "cx43", label: "CX43", cores: 8, memoryGb: 16, diskGb: 160, monthlyCents: 1649, currency: "EUR" },
  target: { slug: "cpx32", label: "CPX32 · 4 vCPU · 8 GB · 160 GB", cores: 4, memoryGb: 8, diskGb: 160, monthlyCents: 1200, currency: "EUR" },
  savingsCents: 449,
  priceBasis: "provider",
  upgradeDisk: false,
  diskBlocked: false,
  rescale: "api",
  rescaleBlocked: null,
  ...o,
});

function mock(t: TeamCost, a: ServerAdvice[] = []) {
  vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
  vi.spyOn(api, "getCosts").mockResolvedValue({ teams: [t] } satisfies CostsReport);
  vi.spyOn(api, "getCostAdvice").mockResolvedValue({ advice: a, snapshotDate: "2026-11-24" } satisfies AdviceReport);
  vi.spyOn(api, "getRescale").mockResolvedValue({ rescale: null });
}

describe("CostsPage", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the monthly total, where each price comes from, and that estimates are dated", async () => {
    mock(team());
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("web-1")).toBeTruthy());
    expect(screen.getAllByText("€5.99/mo").length).toBeGreaterThan(0);
    expect(screen.getByText("Estimate")).toBeTruthy();
    expect(screen.getByText(/Estimated from Hetzner list prices, 2026-11-24/)).toBeTruthy();
    expect(screen.getByText(/Prices exclude VAT/)).toBeTruthy();
  });

  it("shows an empty state for a team with no servers", async () => {
    mock(team({ servers: [], totals: [] }));
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("No servers yet")).toBeTruthy());
  });

  it("corrects a price in one step", async () => {
    mock(team());
    const set = vi.spyOn(api, "setServerCost").mockResolvedValue({ ok: true });
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("web-1")).toBeTruthy());
    fireEvent.click(screen.getByText("Correct price"));
    fireEvent.change(screen.getByLabelText("Monthly price"), { target: { value: "12,50" } });
    fireEvent.click(screen.getByText("Save price"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("s1", { monthly: 12.5, currency: "EUR" }));
  });

  it("refuses a price that is not a number", async () => {
    mock(team());
    const set = vi.spyOn(api, "setServerCost").mockResolvedValue({ ok: true });
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("web-1")).toBeTruthy());
    fireEvent.click(screen.getByText("Correct price"));
    fireEvent.change(screen.getByLabelText("Monthly price"), { target: { value: "lots" } });
    fireEvent.click(screen.getByText("Save price"));
    await waitFor(() => expect(screen.getByText("Enter an amount such as 12.50.")).toBeTruthy());
    expect(set).not.toHaveBeenCalled();
  });

  it("a viewer cannot correct prices or save a bill", async () => {
    mock(team({ canManage: false, canOps: false }));
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("web-1")).toBeTruthy());
    expect(screen.queryByText("Correct price")).toBeNull();
    expect(screen.queryByText(/Save today's bill/)).toBeNull();
  });

  it("splits a server's price over what runs on it", async () => {
    mock(team({ servers: [server({ apps: [{ key: "app:a1", kind: "app", resourceId: "a1", name: "Shop", sharePct: 70, cents: 419 }, { key: "system", kind: "system", resourceId: null, name: "system", sharePct: 30, cents: 180 }] })] }));
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("web-1")).toBeTruthy());
    fireEvent.click(screen.getByText("Show what uses it"));
    expect(screen.getByText("Shop")).toBeTruthy();
    expect(screen.getByText("Tugra and system")).toBeTruthy();
    expect(screen.getByLabelText("Shop, 70% of this server")).toBeTruthy();
  });

  it("saves today's bill as the before bill", async () => {
    mock(team());
    const create = vi.spyOn(api, "createCostBaseline").mockResolvedValue({ id: "b1" });
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("web-1")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Before migration" } });
    fireEvent.click(screen.getByText(/Save today's bill/));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ teamId: "t1", label: "Before migration" }));
  });

  it("shows the before and after bill with a summary line to copy", async () => {
    const baseline = { id: "b1", label: "Before migration", monthlyCents: 20000, currency: "EUR", createdAt: "2026-11-01T00:00:00Z", servers: 3 };
    mock(team({ baselines: [baseline], comparison: { baseline, currency: "EUR", beforeCents: 20000, afterCents: 6000, deltaCents: -14000, deltaPct: -70, yearlyDeltaCents: -168000, includesEstimates: true } }));
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("web-1")).toBeTruthy());
    expect(screen.getByText("Your bill went from €200 to €60 a month. That is €140 less, €1,680 a year.")).toBeTruthy();
    expect(screen.getByText("Includes estimated prices.")).toBeTruthy();
    expect(screen.getByText("Copy summary")).toBeTruthy();
  });

  it("explains a downsize with the saving, and offers the resize for a linked provider", async () => {
    mock(team(), [advice()]);
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("Can go down to CPX32")).toBeTruthy());
    expect(screen.getByText(/Saves about €4.49 a month/)).toBeTruthy();
    expect(screen.getByText("Resize now")).toBeTruthy();
  });

  it("resizing needs the server name typed, then starts the move", async () => {
    mock(team(), [advice()]);
    const start = vi.spyOn(api, "startRescale").mockResolvedValue({ id: "r1", serverId: "s1", provider: "hetzner", fromPlan: "cx43", toPlan: "cpx32", phase: "SHUTTING_DOWN", error: null, startedAt: "2026-11-24T00:00:00Z", finishedAt: null });
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("Resize now")).toBeTruthy());
    fireEvent.click(screen.getByText("Resize now"));
    const confirm = screen.getByRole("button", { name: "Resize" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type the server name to confirm"), { target: { value: "web-1" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(start).toHaveBeenCalledWith("s1", { planSlug: "cpx32", confirmName: "web-1" }));
  });

  it("without a provider API it shows step-by-step instructions and no resize button", async () => {
    mock(team(), [advice({ rescale: "guide", provider: "digitalocean", priceBasis: "list" })]);
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("Can go down to CPX32")).toBeTruthy());
    expect(screen.queryByText("Resize now")).toBeNull();
    fireEvent.click(screen.getByText("How to resize"));
    expect(screen.getByText("Resize web-1 at DigitalOcean")).toBeTruthy();
    expect(screen.getByText(/Open the DigitalOcean control panel/)).toBeTruthy();
  });

  it("flags a server near its limit and warns that disks cannot shrink when that blocks a smaller one", async () => {
    mock(team(), [
      advice({ kind: "near_limit", reasons: ["cpu"], target: { slug: "cx53", label: "CX53", cores: 16, memoryGb: 32, diskGb: 320, monthlyCents: 2999, currency: "EUR" }, savingsCents: -1350 }),
      advice({ serverId: "s2", name: "db-1", diskBlocked: true, rescale: "guide" }),
    ]);
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("Near its limit")).toBeTruthy());
    expect(screen.getByText("CPU is close to full at peak.")).toBeTruthy();
    expect(screen.getByText(/Adds about €13.50 a month/)).toBeTruthy();
    expect(screen.getByText("Disks cannot shrink, so this means moving to a new, smaller server.")).toBeTruthy();
  });

  it("says how many days are collected while a server is still learning", async () => {
    mock(team(), [advice({ kind: "learning", target: null, savingsCents: null, usage: null, daysCollected: 6.2 })]);
    wrap(<CostsPage />);
    await waitFor(() => expect(screen.getByText("Learning: 6.2 of 14 days collected.")).toBeTruthy());
  });

  it("reads provider prices on its own for a linked server, and on request", async () => {
    mock(team({ servers: [server({ canSync: true })] }));
    const sync = vi.spyOn(api, "syncCosts").mockResolvedValue({ synced: 1, failed: [] });
    wrap(<CostsPage />);
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1)); // automatic, once
    fireEvent.click(await screen.findByText("Read prices from provider"));
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    expect(sync).toHaveBeenCalledWith("t1");
  });

  it("re-reads a provider price that is more than a day old, but not a fresh one", async () => {
    const sync = vi.spyOn(api, "syncCosts").mockResolvedValue({ synced: 1, failed: [] });
    mock(team({ servers: [server({ canSync: true, source: "provider", syncedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() })] }));
    wrap(<CostsPage />);
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  });

  it("leaves a freshly read provider price alone", async () => {
    const sync = vi.spyOn(api, "syncCosts").mockResolvedValue({ synced: 1, failed: [] });
    mock(team({ servers: [server({ canSync: true, source: "provider", syncedAt: new Date().toISOString() })] }));
    wrap(<CostsPage />);
    await screen.findByText("Read prices from provider");
    expect(sync).not.toHaveBeenCalled();
  });
});
