import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { HottestContainersCard } from "./hottest-containers-card";
import { api } from "../lib/api";
import type { HottestContainerRow } from "../lib/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const row = (over: Partial<HottestContainerRow>): HottestContainerRow => ({
  serverId: "s1", serverName: "alpha", containerName: "tugra_app1", label: "WordPress", kind: "app", resourceId: "app1",
  cpu: 80, memUsed: 512 * 1024 * 1024, memTotal: 1024 * 1024 * 1024, memPct: 50, netRx: 2048, netTx: 1024, blkRead: 0, blkWrite: 4096,
  ...over,
});

describe("HottestContainersCard", () => {
  it("renders ranked rows with links to the app/db and the server", async () => {
    const spy = vi.spyOn(api, "getFleetHottestContainers").mockResolvedValue([
      row({}),
      row({ serverId: "s2", serverName: "beta", containerName: "tugra_db_d1", label: "main-pg", kind: "db", resourceId: "d1", cpu: 30 }),
      row({ serverId: "s2", serverName: "beta", containerName: "nginx", label: "nginx", kind: "other", resourceId: undefined, cpu: 5 }),
    ]);
    wrap(<HottestContainersCard teamId="t1" />);
    expect(await screen.findByText("WordPress")).toBeTruthy();
    expect(spy).toHaveBeenCalledWith(10, "t1");
    expect(screen.getByRole("table", { name: "Hottest containers" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "WordPress" }).getAttribute("href")).toBe("/apps/app1");
    expect(screen.getByRole("link", { name: "main-pg" }).getAttribute("href")).toBe("/databases/d1");
    expect(screen.getByRole("link", { name: "alpha" }).getAttribute("href")).toBe("/servers/s1");
    expect(screen.getAllByRole("link", { name: "beta" })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "nginx" })).toBeNull(); // no resourceId → plain label
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("1")).toBeTruthy();
    expect(within(rows[0]).getByText("80%")).toBeTruthy();
    expect(within(rows[0]).getByText("512 MB / 1.0 GB")).toBeTruthy();
    expect(within(rows[2]).getByText("3")).toBeTruthy();
  });

  it("shows an empty state when nothing is live", async () => {
    vi.spyOn(api, "getFleetHottestContainers").mockResolvedValue([]);
    wrap(<HottestContainersCard />);
    expect(await screen.findByText("No running containers are reporting yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a loading skeleton, not the empty message, while the first fetch is in flight", async () => {
    vi.spyOn(api, "getFleetHottestContainers").mockReturnValue(new Promise(() => {}));
    wrap(<HottestContainersCard />);
    expect(await screen.findByRole("status", { name: "Loading…" })).toBeTruthy();
    expect(screen.queryByText("No running containers are reporting yet")).toBeNull();
  });

  it("shows an error message with retry, not the empty message, when the fetch fails", async () => {
    vi.spyOn(api, "getFleetHottestContainers").mockRejectedValue(new Error("500"));
    wrap(<HottestContainersCard />);
    expect(await screen.findByText("Couldn't load the hottest containers")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("No running containers are reporting yet")).toBeNull();
  });
});
