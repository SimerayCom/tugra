import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { api } from "../../../../lib/api";
import type { Monitor, StatusPageManage, Team } from "../../../../lib/types";

vi.mock("../../../../components/toast", () => ({ useToast: () => vi.fn() }));

import StatusPageSettingsPage from "./page";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const teams: Team[] = [
  { id: "t1", name: "Acme Inc", role: "OWNER", memberCount: 2 },
  { id: "t2", name: "Client team", role: "VIEWER", memberCount: 5, clientAccess: "view" },
];
const mons = [
  { id: "m1", name: "Website", teamId: "t1" },
  { id: "m2", name: "internal-db-eu-1", teamId: "t1" },
  { id: "m3", name: "Other", teamId: "t9" },
] as unknown as Monitor[];

function setup(manage: StatusPageManage) {
  vi.spyOn(api, "listTeams").mockResolvedValue(teams);
  vi.spyOn(api, "listMonitors").mockResolvedValue(mons);
  vi.spyOn(api, "getStatusPage").mockResolvedValue(manage);
  const save = vi.spyOn(api, "saveStatusPage").mockImplementation(async () => manage);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><I18nProvider><ConfirmProvider><StatusPageSettingsPage /></ConfirmProvider></I18nProvider></QueryClientProvider>);
  return { save };
}

describe("status page settings", () => {
  it("offers only the team's own monitors, defaults the address from the team name and saves the chosen ones with their public names", async () => {
    const { save } = setup({ page: null, emailAvailable: false });
    const slug = (await screen.findByLabelText("Address")) as HTMLInputElement;
    expect(slug.value).toBe("acme-inc");
    fireEvent.click(await screen.findByLabelText("Website"));
    expect(screen.queryByText("Other")).toBeNull(); // another team's monitor
    expect(screen.queryByText("Client team")).toBeNull(); // a team the user is only a client of
    fireEvent.click(screen.getByLabelText("internal-db-eu-1"));
    fireEvent.change(screen.getByLabelText("Public name (optional): internal-db-eu-1"), { target: { value: "Database" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("t1", {
        slug: "acme-inc",
        title: "Acme Inc",
        description: null,
        enabled: true,
        monitors: [{ monitorId: "m1", label: null }, { monitorId: "m2", label: "Database" }],
      }),
    );
  });

  it("blocks an invalid address and explains the rule", async () => {
    const { save } = setup({ page: null, emailAvailable: false });
    const slug = await screen.findByLabelText("Address");
    fireEvent.change(slug, { target: { value: "no spaces!" } });
    expect(screen.getByText("Use 3 to 40 lowercase letters, digits or dashes.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("shows the links and an honest note when email is not set up", async () => {
    setup({
      page: { slug: "acme", title: "Acme", description: null, enabled: true, monitors: [], maintenance: [], subscribers: { confirmed: 0, pending: 0 }, url: "https://panel.example.com/status/acme", rssUrl: "https://panel.example.com/api/v1/public/status/acme/rss" },
      emailAvailable: false,
    });
    await screen.findByText("Email updates turn on once mail is set up. RSS works already.");
    expect(screen.getByRole("button", { name: "Copy RSS link" })).toBeTruthy();
    expect(screen.getByText("Nothing planned.")).toBeTruthy();
  });
});
