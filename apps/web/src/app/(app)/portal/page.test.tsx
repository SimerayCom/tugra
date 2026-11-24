import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ConfirmProvider } from "../../../components/confirm";
import { api } from "../../../lib/api";
import type { Application, Database, Monitor, Team } from "../../../lib/types";

vi.mock("../../../components/toast", () => ({ useToast: () => vi.fn() }));

import PortalPage from "./page";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const team = (over: Partial<Team>): Team => ({ id: "t1", name: "Acme", role: "VIEWER", memberCount: 3, clientAccess: "view", ...over });
const app = (over: Record<string, unknown>) => ({ id: "a1", name: "Shop", teamId: "t1", status: "RUNNING", url: "https://shop.example.com", ...over }) as unknown as Application;
const mon = { id: "m1", name: "Shop uptime", teamId: "t1", status: "UP" } as unknown as Monitor;
const db = { id: "d1", name: "shop-db", teamId: "t1" } as unknown as Database;

function setup(teams: Team[]) {
  vi.spyOn(api, "listTeams").mockResolvedValue(teams);
  vi.spyOn(api, "listApps").mockResolvedValue([app({}), app({ id: "a2", name: "Other team app", teamId: "t9" })]);
  vi.spyOn(api, "listMonitors").mockResolvedValue([mon]);
  vi.spyOn(api, "listDatabases").mockResolvedValue([db]);
  vi.spyOn(api, "getUptime").mockResolvedValue({ percent: 99.5, total: 100 });
  vi.spyOn(api, "listBackups").mockResolvedValue([{ id: "b1", status: "SUCCESS", createdAt: "2026-11-24T01:00:00.000Z", completedAt: "2026-11-24T01:05:00.000Z" } as never]);
  const deploy = vi.spyOn(api, "deployApp").mockResolvedValue({} as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><I18nProvider><ConfirmProvider><PortalPage /></ConfirmProvider></I18nProvider></QueryClientProvider>);
  return { deploy };
}

describe("customer portal", () => {
  it("shows the client's apps, uptime and backups, and nothing from other teams", async () => {
    setup([team({})]);
    await screen.findByText("Shop");
    expect(screen.queryByText("Other team app")).toBeNull();
    expect(screen.getByText("Shop uptime")).toBeTruthy();
    await screen.findByText("99.5% in 24 h");
    expect(screen.getByText("shop-db")).toBeTruthy();
    await screen.findByText(/Last backup/);
  });

  it("a view-only client has no deploy button", async () => {
    setup([team({ clientAccess: "view" })]);
    await screen.findByText("Shop");
    expect(screen.queryByRole("button", { name: /Deploy/ })).toBeNull();
  });

  it("a deploy client can deploy after confirming", async () => {
    const { deploy } = setup([team({ clientAccess: "deploy" })]);
    fireEvent.click(await screen.findByRole("button", { name: "Deploy: Shop" }));
    fireEvent.click(await screen.findByRole("button", { name: /^(Confirm|OK|Yes|Deploy)$/ }));
    await waitFor(() => expect(deploy).toHaveBeenCalledWith("a1"));
  });

  it("says nothing is shared when the account is a client of no team", async () => {
    setup([team({ clientAccess: null, role: "OWNER" })]);
    await screen.findByText("Nothing is shared with you yet.");
  });
});
