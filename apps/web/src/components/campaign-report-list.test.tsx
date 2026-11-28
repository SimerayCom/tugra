import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { api } from "../lib/api";
import { CampaignReportList } from "./campaign-report-list";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("./team-scope", () => ({ useTeamContext: () => ({ teams: [] }), useTeamScope: () => ({ teamId: null }) }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const c = (id: string, label: string, status: "draft" | "running" | "paused" | "done" | "cancelled", createdAt = "2026-11-28T11:05:00.000Z") => ({ id, teamId: "t1", label, sessionId: null, status, plan: [], runIds: ["r"], createdAt });
const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><CampaignReportList teamId="t1" /></I18nProvider></QueryClientProvider>);

describe("CampaignReportList", () => {
  it("shows what is going on and hides the cancelled and finished moves behind tabs that count them", async () => {
    vi.spyOn(api, "listCampaigns").mockResolvedValue([c("c1", "Olgu servers", "running"), c("c2", "old try", "cancelled"), c("c3", "done one", "done"), c("c4", "campaign-20261127-0900-zz99", "cancelled")]);
    show();
    await screen.findByText("Olgu servers");
    expect(screen.queryByText("old try")).toBeNull();
    expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual(["Live1", "Done1", "Cancelled2", "All4"]);
    fireEvent.click(screen.getByRole("tab", { name: /Cancelled/ }));
    await screen.findByText("old try");
    // a generated label never shows as itself
    expect(screen.queryByText("campaign-20261127-0900-zz99")).toBeNull();
    expect(screen.getByText(/^Move of /)).toBeTruthy();
    expect(screen.queryByText("Olgu servers")).toBeNull();
  });

  it("each row is one link to the campaign's page by its id", async () => {
    vi.spyOn(api, "listCampaigns").mockResolvedValue([c("c1", "28 Kas 14:05", "paused")]);
    show();
    const link = (await screen.findByText("28 Kas 14:05")).closest("a");
    expect(link?.getAttribute("href")).toBe("/import/runs/campaign?id=c1");
    expect(screen.getByText("Waiting for you")).toBeTruthy();
  });

  it("says so when the tab is empty but other moves exist, and keeps the none-yet text for a team with no campaign at all", async () => {
    vi.spyOn(api, "listCampaigns").mockResolvedValue([c("c2", "old try", "cancelled")]);
    show();
    await screen.findByTestId("campaigns-filtered-none");
    await waitFor(() => expect(screen.getByRole("tab", { name: /Cancelled/ })).toBeTruthy());
    cleanup();
    vi.mocked(api.listCampaigns).mockResolvedValue([]);
    show();
    await screen.findByTestId("campaigns-none");
  });
});
