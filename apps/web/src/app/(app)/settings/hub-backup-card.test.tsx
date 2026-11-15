import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { HubBackupView } from "../../../lib/types";

const h = vi.hoisted(() => ({ owner: true }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { isInstanceOwner: h.owner } }) }));
vi.mock("../../../components/toast", () => ({ useToast: () => vi.fn() }));

import { HubBackupCard } from "./hub-backup-card";

const view = (over: Partial<HubBackupView> = {}): HubBackupView => ({
  enabled: true, intervalHours: 24, cron: null, retention: 7, retentionDays: null, maxSizeGb: null, destinationId: null, last: null, items: [], ...over,
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <I18nProvider><HubBackupCard /></I18nProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  h.owner = true;
  vi.spyOn(api, "getHubBackup").mockResolvedValue(view());
  vi.spyOn(api, "listDestinations").mockResolvedValue([]);
  vi.spyOn(api, "previewSchedule").mockResolvedValue({ valid: true, timezone: "UTC", nextRuns: ["2026-11-16T03:00:00Z"], minGapSeconds: 86400 });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe("HubBackupCard", () => {
  it("shows the always-encrypted row and the reworded .env warning", async () => {
    show();
    expect(await screen.findByText(/Always encrypted with a key derived from your \.env/)).toBeTruthy();
    expect(screen.getByText(/Destination encryption keys are inside this backup, protected by your \.env key\./)).toBeTruthy();
  });

  it("saves cron + retention days + max size", async () => {
    const set = vi.spyOn(api, "setHubBackup").mockResolvedValue(view());
    vi.spyOn(api, "getHubBackup").mockResolvedValue(view({ intervalHours: 12 }));
    show();
    await waitFor(() => expect((screen.getByLabelText("Every (hours)") as HTMLInputElement).value).toBe("12")); // loaded
    fireEvent.click(screen.getByLabelText("Cron expression"));
    fireEvent.change(screen.getByLabelText("Max age (days)"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Max total size (GB)"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set).toHaveBeenCalledWith({ enabled: true, intervalHours: 12, cron: "0 3 * * *", retention: 7, retentionDays: 30, maxSizeGb: 20, destinationId: null });
  });

  it("the Export encryption keys button opens the sealed-export modal", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Export encryption keys" }));
    expect(screen.getByRole("dialog", { name: "Export encryption keys" })).toBeTruthy();
  });

  it("renders nothing for a non-owner", () => {
    h.owner = false;
    show();
    expect(screen.queryByText("Control-plane backup")).toBeNull();
  });
});
