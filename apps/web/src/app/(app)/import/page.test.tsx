import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import ImportPage from "./page";

vi.mock("../../../components/import-wizard", () => ({ ImportWizard: () => <div data-testid="wizard" /> }));
afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "OWNER" }]);
  vi.spyOn(api, "listCampaigns").mockResolvedValue([{ id: "c1", label: "wave 1", sessionId: null, status: "running", plan: [], runIds: ["r1"], createdAt: new Date().toISOString() }]);
});
const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><ImportPage /></I18nProvider></QueryClientProvider>);

describe("Import page entry points", () => {
  it("links to the Move off Coolify checklist and to the Coolify host connection", async () => {
    show();
    expect(screen.getByTestId("move-off-link").querySelector("a")?.getAttribute("href")).toBe("/import/move-off-coolify");
    expect(screen.getAllByRole("link", { name: "Read this Coolify" }).some((a) => a.getAttribute("href") === "/import/coolify-host")).toBe(true);
  });

  it("lists the campaign reports under the wizard, each row a link to the campaign by its id", async () => {
    show();
    const list = await screen.findByTestId("campaign-list");
    expect(list.querySelector("a")?.getAttribute("href")).toBe("/import/runs/campaign?id=c1");
    await waitFor(() => expect(api.listCampaigns).toHaveBeenCalledWith("t1"));
  });
});
