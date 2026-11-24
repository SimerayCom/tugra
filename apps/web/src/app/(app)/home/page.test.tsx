import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ConfirmProvider } from "../../../components/confirm";
import { ToastProvider } from "../../../components/toast";
import { api } from "../../../lib/api";

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav, usePathname: () => "/home", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { uiMode: "home" }, reload: vi.fn(async () => {}) }) }));
// Gauges and the tunnel card do their own fetching; stub them so the page logic is what's under test.
vi.mock("../../../components/live-gauges", () => ({ LiveGauges: ({ id }: { id: string }) => <div data-testid="gauges">{id}</div> }));
vi.mock("../../../components/remote-access-card", () => ({ RemoteAccessCard: ({ serverId }: { serverId: string }) => <div data-testid="remote">{serverId}</div> }));

import HomePage from "./page";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const server = (i: number, teamId: string) => ({
  id: `s${i}`, name: `host-${i}`, teamId, status: i % 10 === 9 ? "OFFLINE" : "ONLINE", isLocal: i === 0, canWrite: true, uptimeSeconds: 90_000 + i,
});
const app = (i: number, teamId: string, projectName = "Default") => ({
  id: `a${i}`, name: `app-${i}`, url: null, status: "RUNNING", source: "IMAGE", templateSlug: null, templateLogo: null, iconUpdatedAt: null,
  exposeMode: "magic", domain: null, tunnelExposed: false, canWrite: true, teamId, projectId: `${teamId}-${projectName}`, projectName, serverId: "s0",
});

interface Setup { servers: number; teams: number; apps: number }
function setup({ servers, teams, apps }: Setup) {
  const teamIds = Array.from({ length: teams }, (_, i) => `t${i}`);
  vi.spyOn(api, "listServers").mockResolvedValue(Array.from({ length: servers }, (_, i) => server(i, teamIds[i % teams])) as never);
  vi.spyOn(api, "listTeams").mockResolvedValue(teamIds.map((id, i) => ({ id, name: `Acme ${i}`, role: "OWNER" })) as never);
  vi.spyOn(api, "listApps").mockResolvedValue(Array.from({ length: apps }, (_, i) => app(i, teamIds[i % teams])) as never);
  vi.spyOn(api, "listDatabases").mockResolvedValue([{ backupSupported: true, backupEnabled: true }, { backupSupported: true, backupEnabled: false }] as never);
  vi.spyOn(api, "getFleetMetrics").mockResolvedValue(
    Array.from({ length: servers }, (_, i) => ({ serverId: `s${i}`, sample: { ts: Date.now(), cpu: 5, memUsed: 1, memTotal: 2, diskUsed: 50, diskTotal: 200, netRx: 0, netTx: 0, diskRead: 0, diskWrite: 0 } })) as never,
  );
  const update = vi.spyOn(api, "updateProfile").mockResolvedValue({} as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <ToastProvider>
            <HomePage />
          </ToastProvider>
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { update };
}
const settled = async (apps: number) => {
  if (apps === 0) await screen.findByText("No apps yet");
  else await screen.findByText("app-0");
  await waitFor(() => expect(api.listServers).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 30)); // let the servers/teams queries land too
};
const tileCount = () => screen.queryAllByText(/^app-\d+$/).length;

describe("Home page scenarios", () => {
  beforeEach(() => vi.useRealTimers());

  it("1 server / 1 team / 0 apps: calm empty state, no fleet hint, no picker", async () => {
    setup({ servers: 1, teams: 1, apps: 0 });
    await settled(0);
    expect(screen.queryByText("Fleet mode suits you better")).toBeNull();
    expect(screen.queryByLabelText("Show stats for")).toBeNull();
    expect(screen.getByText("1 of 1 online")).toBeTruthy();
    expect(screen.getByTestId("gauges").textContent).toBe("s0");
  });

  it("1 server / 1 team / 100 apps: flat list, no hint, no group headings", async () => {
    setup({ servers: 1, teams: 1, apps: 100 });
    await settled(100);
    expect(tileCount()).toBe(100);
    expect(screen.queryByText("Fleet mode suits you better")).toBeNull();
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  }, 30_000);

  it("5 servers / 1 team / 0 apps: suggests Fleet and offers a server picker", async () => {
    setup({ servers: 5, teams: 1, apps: 0 });
    await settled(0);
    expect(screen.getByText("Fleet mode suits you better")).toBeTruthy();
    expect(screen.getByText("You have 5 servers and 1 team. Fleet mode shows all of them.")).toBeTruthy();
    expect(within(screen.getByLabelText("Show stats for")).getAllByRole("option").length).toBe(5 + 1); // + disabled placeholder
  });

  it("30 servers / 8 teams / 100 apps: groups by team, keeps every tile, picker drives the gauges", async () => {
    setup({ servers: 30, teams: 8, apps: 100 });
    await settled(100);
    expect(screen.getByText("You have 30 servers and 8 teams. Fleet mode shows all of them.")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(Array.from({ length: 8 }, (_, i) => `Acme ${i}`));
    expect(tileCount()).toBe(100);
    expect(within(screen.getByLabelText("Show stats for")).getAllByRole("option").length).toBe(30 + 1);
    expect(screen.getByTestId("gauges").textContent).toBe("s0"); // default: this machine
    fireEvent.change(screen.getByLabelText("Show stats for"), { target: { value: "s17" } });
    expect(screen.getByTestId("gauges").textContent).toBe("s17");
    expect(JSON.parse(localStorage.getItem("tugra.home.layout")!).gaugeServerId).toBe("s17");
  }, 30_000);

  it("30 servers / 8 teams / 0 apps: empty state plus the hint", async () => {
    setup({ servers: 30, teams: 8, apps: 0 });
    await settled(0);
    expect(screen.getByText("Fleet mode suits you better")).toBeTruthy();
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });

  it("dismissing the hint hides it and remembers", async () => {
    setup({ servers: 5, teams: 1, apps: 0 });
    await settled(0);
    fireEvent.click(screen.getByText("Not now"));
    expect(screen.queryByText("Fleet mode suits you better")).toBeNull();
    expect(JSON.parse(localStorage.getItem("tugra.home.layout")!).fleetHintDismissed).toBe(true);
  });

  it("the hint's button switches to Fleet without a confirmation", async () => {
    const { update } = setup({ servers: 5, teams: 1, apps: 0 });
    await settled(0);
    fireEvent.click(screen.getByText("Switch to Fleet"));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ uiMode: "fleet" }));
  });

  it("widgets reflect the picked server, backups and servers", async () => {
    setup({ servers: 5, teams: 1, apps: 0 });
    await settled(0);
    const widgets = screen.getByRole("group", { name: "Widgets" });
    expect(within(widgets).getByText("5 of 5 online")).toBeTruthy();
    expect(within(widgets).getAllByText("25%").length).toBeGreaterThan(0);
    expect(within(widgets).getByText("1/2")).toBeTruthy();
    expect(within(widgets).getByText("1d 1h")).toBeTruthy();
  });
});

describe("Home customization", () => {
  it("reorders with the arrows and persists the order", async () => {
    setup({ servers: 1, teams: 1, apps: 3 });
    await settled(3);
    fireEvent.click(screen.getByText("Customize"));
    fireEvent.click(screen.getByLabelText("Move app-2 earlier"));
    const names = () => screen.getAllByText(/^app-\d+$/).map((n) => n.textContent);
    expect(names()).toEqual(["app-0", "app-2", "app-1"]);
    expect(JSON.parse(localStorage.getItem("tugra.home.layout")!).order).toEqual(["a0", "a2", "a1"]);
  });

  it("reorders by drag and drop", async () => {
    setup({ servers: 1, teams: 1, apps: 3 });
    await settled(3);
    fireEvent.click(screen.getByText("Customize"));
    const dt = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(screen.getByTestId("tile-a0"), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId("tile-a2"), { dataTransfer: dt });
    expect(screen.getAllByText(/^app-\d+$/).map((n) => n.textContent)).toEqual(["app-1", "app-2", "app-0"]);
  });

  it("creates a folder, files an app into it and shows it as a group", async () => {
    setup({ servers: 1, teams: 1, apps: 3 });
    await settled(3);
    fireEvent.click(screen.getByText("Customize"));
    fireEvent.click(screen.getByText("Add folder"));
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Media" } });
    fireEvent.change(screen.getByLabelText("Folder for app-1"), { target: { value: JSON.parse(localStorage.getItem("tugra.home.layout")!).folders[0].id } });
    const heads = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(heads).toEqual(["Media", "Other apps"]);
    const media = screen.getByRole("region", { name: "Media" });
    expect(within(media).getByText("app-1")).toBeTruthy();
  });

  it("applies a wallpaper and can hide a widget", async () => {
    setup({ servers: 1, teams: 1, apps: 1 });
    await settled(1);
    fireEvent.click(screen.getByText("Customize"));
    fireEvent.click(screen.getByRole("radio", { name: "Ocean" }));
    expect(JSON.parse(localStorage.getItem("tugra.home.layout")!).wallpaper).toBe("ocean");
    fireEvent.click(within(screen.getAllByRole("group", { name: "Widgets" })[0]).getByLabelText("Backups"));
    expect(JSON.parse(localStorage.getItem("tugra.home.layout")!).widgets.backups).toBe(false);
  });

  it("restores a saved layout on load", async () => {
    localStorage.setItem("tugra.home.layout", JSON.stringify({ order: ["a2", "a0", "a1"] }));
    setup({ servers: 1, teams: 1, apps: 3 });
    await settled(3);
    await waitFor(() => expect(screen.getAllByText(/^app-\d+$/).map((n) => n.textContent)).toEqual(["app-2", "app-0", "app-1"]));
  });
});
