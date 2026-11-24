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
  enabled: true, intervalHours: 24, cron: null, retention: 7, retentionDays: null, maxSizeGb: null, destinationId: null, extraDestinationId: null, offBox: false, drillEnabled: true,
  drill: { last: null, overdue: false },
  deadman: { enabled: false, intervalMinutes: 5, urlSet: false, urlHost: null, lastPingAt: null, lastOkAt: null, lastError: null, failStreak: 0 },
  last: null, items: [], ...over,
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
    expect(screen.getByText(/Destination encryption keys inside it are protected by your \.env key\./)).toBeTruthy();
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
    expect(set).toHaveBeenCalledWith({ enabled: true, intervalHours: 12, cron: "0 3 * * *", retention: 7, retentionDays: 30, maxSizeGb: 20, destinationId: null, extraDestinationId: null, drillEnabled: true });
  });

  it("the Export encryption keys button opens the sealed-export modal", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Export encryption keys" }));
    expect(screen.getByRole("dialog", { name: "Export encryption keys" })).toBeTruthy();
  });

  it("nudges toward an off-box destination while the backup is on this disk, and not once one is set", async () => {
    const first = show();
    expect(await screen.findByText(/lost with the server/)).toBeTruthy();
    first.unmount();
    vi.spyOn(api, "getHubBackup").mockResolvedValue(view({ destinationId: "d1", offBox: true }));
    vi.spyOn(api, "listDestinations").mockResolvedValue([{ id: "d1", name: "Bucket" } as never]);
    show();
    await waitFor(() => expect((screen.getAllByLabelText("Destination")[0] as HTMLSelectElement).value).toBe("d1"));
    expect(screen.queryByText(/lost with the server/)).toBeNull();
  });

  it("saves a third copy that differs from the main destination", async () => {
    const set = vi.spyOn(api, "setHubBackup").mockResolvedValue(view());
    vi.spyOn(api, "getHubBackup").mockResolvedValue(view({ destinationId: "d1", offBox: true }));
    vi.spyOn(api, "listDestinations").mockResolvedValue([{ id: "d1", name: "Main" }, { id: "d2", name: "Second" }] as never);
    show();
    await waitFor(() => expect(screen.getAllByRole("option", { name: "Second" }).length).toBe(2));
    fireEvent.change(screen.getByLabelText("Third copy (optional)"), { target: { value: "d2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][0]).toMatchObject({ destinationId: "d1", extraDestinationId: "d2" });
  });

  it("shows the drill result and runs a drill on demand", async () => {
    vi.spyOn(api, "getHubBackup").mockResolvedValue(view({ items: [{ id: "b1", status: "SUCCESS", filename: "f", sizeBytes: "1", errorTail: null, createdAt: "2026-11-01T00:00:00Z", completedAt: null }], drill: { overdue: true, last: { id: "d", status: "SUCCESS", trigger: "schedule", backupFilename: "f", tables: 31, checks: { User: 1 }, errorTail: null, durationMs: 5, createdAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:05:00Z" } } }));
    const run = vi.spyOn(api, "runHubDrill").mockResolvedValue({ id: "d2", status: "SUCCESS" } as never);
    show();
    expect(await screen.findByText(/31 tables restored/)).toBeTruthy();
    expect(screen.getByText(/more than a month old/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run drill now" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
  });

  it("saves the check-in address without ever showing it back", async () => {
    const set = vi.spyOn(api, "setHubDeadman").mockResolvedValue({} as never);
    vi.spyOn(api, "getHubBackup").mockResolvedValue(view({ deadman: { enabled: true, intervalMinutes: 5, urlSet: true, urlHost: "hc.example.com", lastPingAt: null, lastOkAt: null, lastError: null, failStreak: 0 } }));
    show();
    expect(await screen.findByText(/Saved for hc\.example\.com/)).toBeTruthy();
    expect((screen.getByLabelText("Check-in address") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Check-in address"), { target: { value: "https://hc.example.com/ping/tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Save check-in" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 5, url: "https://hc.example.com/ping/tok" }));
  });

  it("renders nothing for a non-owner", () => {
    h.owner = false;
    show();
    expect(screen.queryByText("Control-plane backup")).toBeNull();
  });
});
