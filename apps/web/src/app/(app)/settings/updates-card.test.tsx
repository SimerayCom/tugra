import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { InstanceUpdateStatus, PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { UpdatesCard } from "./updates-card";

const STATUS: InstanceUpdateStatus = {
  current: "0.1.0",
  latest: "0.2.0",
  channel: "stable",
  updateAvailable: true,
  changelogUrl: "https://get.tugra.io/changelog",
  autoUpdate: false,
};

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <UpdatesCard />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("UpdatesCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "getInstanceUpdate").mockResolvedValue({ ...STATUS });
    vi.spyOn(api, "updateInstanceUpdate").mockResolvedValue({ ...STATUS, autoUpdate: true });
    vi.spyOn(api, "checkInstanceUpdate").mockResolvedValue({ ...STATUS });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches", () => {
    wrap();
    expect(screen.queryByText("Updates")).toBeNull();
    expect(api.getInstanceUpdate).not.toHaveBeenCalled();
  });

  it("shows the status for the owner (current, latest, update-available badge, changelog)", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    expect(await screen.findByText("Updates")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("0.1.0")).toBeTruthy());
    expect(screen.getByText(/Update available/)).toBeTruthy();
    expect(screen.getByText("View changelog")).toBeTruthy();
    expect(screen.getByText(/Re-run your installer/)).toBeTruthy(); // installer note, no "Update now" button
  });

  it("saves the channel + auto-update toggle", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Updates");
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    fireEvent.click(screen.getByRole("checkbox")); // enable auto-update
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateInstanceUpdate).toHaveBeenCalledWith({ autoUpdate: true, updateChannel: "stable" }),
    );
  });

  it("triggers a manual check", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Updates");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(api.checkInstanceUpdate).toHaveBeenCalled());
  });

  it("keeps unsaved channel edits when a manual check refreshes the status (no clobber)", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Updates");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("stable"));
    fireEvent.change(select, { target: { value: "beta" } }); // unsaved edit
    // the check discovers a newer version → refetch changes `data` identity
    vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, latest: "0.9.0" });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByText(/0\.9\.0/)).toBeTruthy()); // display refreshed
    expect(select.value).toBe("beta"); // ...but the unsaved edit survives
  });
});
