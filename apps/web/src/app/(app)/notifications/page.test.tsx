import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ConfirmProvider } from "../../../components/confirm";
import { api } from "../../../lib/api";
import NotificationsPage from "./page";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("NotificationsPage — event list from the backend single source", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "OWNER" }] as never);
    vi.spyOn(api, "listChannels").mockResolvedValue([] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders the events fetched from /channels/events (incl. backup_failed) and omits monitor events", async () => {
    vi.spyOn(api, "listChannelEvents").mockResolvedValue({ events: ["deploy_failed", "server_offline", "backup_failed"] });
    wrap(<NotificationsPage />);
    // "Backup failed" is the real i18n label — it only appears if the checkbox came from the fetched list.
    await waitFor(() => expect(screen.getByText("Backup failed")).toBeTruthy());
    expect(screen.getByText("Deploy failed")).toBeTruthy();
    // deploy_success was NOT in the fetched list → its checkbox is absent, proving the list is
    // fetch-driven (the old hardcoded array always included it). Orphan monitor events aren't offered.
    expect(screen.queryByText("Deploy success")).toBeNull();
  });

  it("gracefully renders an unknown event id (raw-key fallback) without crashing", async () => {
    vi.spyOn(api, "listChannelEvents").mockResolvedValue({ events: ["backup_failed", "brand_new_event"] });
    wrap(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText("Backup failed")).toBeTruthy());
    // an id with no EVENT_LABEL / i18n key falls back to the raw key rather than throwing
    expect(screen.getByText("notifications.brand_new_event")).toBeTruthy();
  });
});
