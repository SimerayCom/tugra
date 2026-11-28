import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api, ApiError } from "../../lib/api";
import { CampaignById } from "./campaign-by-id";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("../team-scope", () => ({ useTeamContext: () => ({ teams: [] }) }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const show = (id: string) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><CampaignById id={id} /></I18nProvider></QueryClientProvider>);

describe("CampaignById", () => {
  it("reads the campaign by its id and shows the report of its label", async () => {
    vi.spyOn(api, "getCampaign").mockResolvedValue({ id: "c1", teamId: "t1", label: "28 Kas 14:05", sessionId: null, status: "running", plan: [], runIds: [], createdAt: "2026-11-28T11:05:00.000Z" });
    const list = vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
    vi.spyOn(api, "listCampaigns").mockResolvedValue([]);
    show("c1");
    await screen.findByText("No run carries this campaign label.");
    expect(api.getCampaign).toHaveBeenCalledWith("c1");
    expect(list.mock.calls[0][0]).toMatchObject({ campaign: "28 Kas 14:05" });
  });

  it("an unknown id says the campaign was not found, not that something broke", async () => {
    vi.spyOn(api, "getCampaign").mockRejectedValue(new ApiError(404, "campaign-not-found"));
    show("nope");
    await screen.findByText(/This campaign was not found/);
  });
});
