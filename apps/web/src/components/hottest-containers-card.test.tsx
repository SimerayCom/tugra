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
  try { localStorage.clear(); } catch { /* ignore */ }
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
    expect(spy).toHaveBeenCalledWith(30, "t1"); // over-fetch so hidden system rows still leave a full list
    expect(screen.getByRole("table", { name: "Hottest containers" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "WordPress" }).getAttribute("href")).toBe("/apps/app1");
    expect(screen.getByRole("link", { name: "main-pg" }).getAttribute("href")).toBe("/databases/d1");
    expect(screen.getByRole("link", { name: "alpha" }).getAttribute("href")).toBe("/servers/s1");
    expect(screen.getAllByRole("link", { name: "beta" })).toHaveLength(2);
    // no resourceId (a container Tugra doesn't manage) → opens the server's Containers tab instead of going nowhere
    expect(screen.getByRole("link", { name: "nginx" }).getAttribute("href")).toBe("/servers/s2?tab=containers");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("1")).toBeTruthy();
    expect(within(rows[0]).getByText("80%")).toBeTruthy();
    expect(within(rows[0]).getByText("512 MB / 1.0 GB")).toBeTruthy();
    expect(within(rows[2]).getByText("3")).toBeTruthy();
  });

  it("hides Tugra system containers by default behind a remembered toggle, with a summary line", async () => {
    vi.spyOn(api, "getFleetHottestContainers").mockResolvedValue([
      row({ containerName: "tugra-hub-api-1", label: "hub-api", kind: "system", resourceId: undefined, cpu: 9, memUsed: 300 * 1024 * 1024 }),
      row({}),
      row({ containerName: "tugra-redis-1", label: "redis", kind: "system", resourceId: undefined, cpu: 1, memUsed: 20 * 1024 * 1024 }),
    ]);
    wrap(<HottestContainersCard />);
    expect(await screen.findByText("WordPress")).toBeTruthy();
    expect(screen.queryByText("hub-api")).toBeNull();
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
    expect(screen.getByText("Tugra system: 2 containers · CPU 10% · RAM 320 MB (hidden)")).toBeTruthy();
    screen.getByRole("button", { name: "Show Tugra system containers" }).click();
    expect(await screen.findByText("hub-api")).toBeTruthy();
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(3);
    expect(localStorage.getItem("tugra.showSystemContainers")).toBe("1");
    expect(screen.getByRole("button", { name: "Hide Tugra system containers" })).toBeTruthy();
  });

  it("names a Coolify container after its app and shows project and environment instead of the raw id", async () => {
    vi.spyOn(api, "getFleetHottestContainers").mockResolvedValue([
      row({ containerName: "kgr3jx23x9ck5w2h8n7p4q1z-123456", label: "Blog", kind: "other", resourceId: undefined, project: "Acme Site", environment: "production" }),
    ]);
    wrap(<HottestContainersCard />);
    expect(await screen.findByRole("link", { name: "Blog" })).toBeTruthy();
    expect(screen.getByText("Acme Site · production")).toBeTruthy();
    expect(screen.getByText("kgr3jx23x9ck5w2h8n7p4q1z-123456")).toBeTruthy(); // the raw name stays, but as the small print
  });

  it("shows at most 8 rows and a 'See all' link with the real total", async () => {
    vi.spyOn(api, "getFleetHottestContainers").mockResolvedValue(
      Array.from({ length: 11 }, (_, i) => row({ containerName: `c${i}`, label: `svc-${i}`, resourceId: undefined, kind: "other", cpu: 50 - i })),
    );
    wrap(<HottestContainersCard />);
    expect(await screen.findByText("svc-0")).toBeTruthy();
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(8);
    expect(screen.getByRole("link", { name: "See all (11) →" }).getAttribute("href")).toBe("/fleet");
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
