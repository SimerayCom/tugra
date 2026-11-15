import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { api } from "../../../../lib/api";
import { subscribeToast, type ToastInput } from "../../../../lib/toast-bus";
import type { VolumeBackupConfig } from "../../../../lib/types";
import { VolumeBackupsCard } from "./app-detail-storage-cards";

const cfg = (over: Partial<VolumeBackupConfig> = {}): VolumeBackupConfig => ({
  enabled: true, intervalHours: 12, cron: null, retention: 7, retentionDays: null, maxSizeGb: null, destinationId: null,
  destinationEncrypted: null, policies: [], usage: [{ pool: "app", usedBytes: "1048576", backupCount: 1, unknownSizeCount: 0, budgetGb: null, overBudget: false }], nextRun: null, ...over,
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <I18nProvider>
        <ConfirmProvider>
          <VolumeBackupsCard id="a1" volumes={[{ name: "data", path: "/data" }]} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.spyOn(api, "listVolumeBackups").mockResolvedValue([]);
  vi.spyOn(api, "listDestinations").mockResolvedValue([]);
  vi.spyOn(api, "getVolumeBackupConfig").mockResolvedValue(cfg());
  vi.spyOn(api, "previewSchedule").mockResolvedValue({ valid: true, timezone: "UTC", nextRuns: ["2026-11-16T03:00:00Z"], minGapSeconds: 86400 });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe("VolumeBackupsCard (rebuilt on the shared policy components)", () => {
  it("loads the schedule from GET config, shows the per-volume table and the unencrypted server-disk badge", async () => {
    show();
    await waitFor(() => expect((screen.getByLabelText("Every (hours)") as HTMLInputElement).value).toBe("12"));
    expect(screen.getByText("Per-volume policies")).toBeTruthy();
    expect(screen.getByText("Inherits the app schedule")).toBeTruthy();
    expect(screen.getByTestId("enc-badge").textContent).toBe("Not encrypted (server disk)");
  });

  it("saves a cron schedule with age + size limits (the interval is sent as null)", async () => {
    const set = vi.spyOn(api, "setVolumeBackupConfig").mockResolvedValue({} as never);
    show();
    await waitFor(() => expect((screen.getByLabelText("Every (hours)") as HTMLInputElement).value).toBe("12"));
    fireEvent.click(screen.getByLabelText("Cron expression"));
    fireEvent.change(screen.getByLabelText("Max age (days)"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Max total size (GB)"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set).toHaveBeenCalledWith("a1", { enabled: true, intervalHours: null, cron: "0 3 * * *", retention: 7, retentionDays: 30, maxSizeGb: 20, destinationId: null });
  });

  it("a config refetch (e.g. after a per-volume policy save) does NOT overwrite unsaved app-wide edits", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ConfirmProvider>
            <VolumeBackupsCard id="a1" volumes={[{ name: "data", path: "/data" }]} />
          </ConfirmProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect((screen.getByLabelText("Every (hours)") as HTMLInputElement).value).toBe("12"));
    fireEvent.change(screen.getByLabelText("Every (hours)"), { target: { value: "6" } });
    // the refetch returns a structurally different config (new policy + usage), as after a policy modal save
    (api.getVolumeBackupConfig as ReturnType<typeof vi.fn>).mockResolvedValue(
      cfg({ intervalHours: 12, policies: [{ volumeName: "data", enabled: true, intervalHours: null, cron: null, retention: 3, retentionDays: null, maxSizeGb: null }] }),
    );
    await qc.invalidateQueries({ queryKey: ["volBackupConfig", "a1"] });
    await waitFor(() => expect((api.getVolumeBackupConfig as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 100)); // let the refetched config render + any hydrate effect run
    expect((screen.getByLabelText("Every (hours)") as HTMLInputElement).value).toBe("6");
  });

  describe("restore / backup-now feedback", () => {
    let toasts: ToastInput[];
    let off: () => void;
    const BK = { id: "b1", volumeName: "data", status: "SUCCESS", filename: "f.tar", sizeBytes: "10", destinationId: null, destinationType: null, createdBy: "u", createdAt: "2026-11-15T00:00:00Z", completedAt: null, exitCode: 0, durationMs: 1, errorTail: null } as const;
    beforeEach(() => {
      toasts = [];
      off = subscribeToast((x) => toasts.push(x));
      vi.spyOn(api, "listVolumeBackups").mockResolvedValue([BK] as never);
    });
    afterEach(() => off());

    it("Restore: confirm, then loading + locked while pending (no double fire), started + done toasts", async () => {
      let resolve!: (v: { ok: true }) => void;
      const restore = vi.spyOn(api, "restoreVolumeBackup").mockReturnValue(new Promise((r) => { resolve = r; }));
      show();
      fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
      const busy = await screen.findByRole("button", { name: "Restoring…" });
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(busy);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(toasts.map((x) => x.message)).toContain("Restore started — the volume is being overwritten…");
      resolve({ ok: true });
      await waitFor(() => expect(toasts.map((x) => x.message)).toContain("Volume restored"));
      expect((await screen.findByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("Backup now toasts the outcome of the finished run", async () => {
      vi.spyOn(api, "volumeBackupNow").mockResolvedValue([BK] as never);
      show();
      fireEvent.click(await screen.findByRole("button", { name: "Backup now" }));
      await waitFor(() => expect(toasts.map((x) => x.message)).toContain("Volume backup completed"));
    });
  });
});
