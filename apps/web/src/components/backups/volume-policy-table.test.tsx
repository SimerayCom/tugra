import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import { VolumePolicyTable } from "./volume-policy-table";
import type { VolumeBackupPolicy } from "../../lib/types";

const pol = (over: Partial<VolumeBackupPolicy>): VolumeBackupPolicy => ({
  volumeName: "media", enabled: true, intervalHours: null, cron: null, retention: null, retentionDays: null, maxSizeGb: null, ...over,
});

const volumes = [{ name: "data", path: "/data" }, { name: "media", path: "/m" }, { name: "cache", path: "/c" }];

function show(policies: VolumeBackupPolicy[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <VolumePolicyTable appId="a1" volumes={volumes} policies={policies} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(api, "putVolumePolicy").mockResolvedValue(pol({}));
  vi.spyOn(api, "deleteVolumePolicy").mockResolvedValue({ ok: true });
  vi.spyOn(api, "previewSchedule").mockResolvedValue({ valid: true, timezone: "UTC", nextRuns: ["2026-11-16T03:00:00Z"], minGapSeconds: 86400 });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe("VolumePolicyTable disabled badge", () => {
  it("shows a Disabled badge only on rows whose policy is switched off", () => {
    show([pol({ volumeName: "cache", enabled: false }), pol({ volumeName: "media", cron: "0 4 * * *" })]);
    expect(screen.getAllByText("Disabled")).toHaveLength(1);
  });
});

describe("VolumePolicyTable", () => {
  it("one row per volume: inherits, custom cron / interval, or off", () => {
    show([pol({ volumeName: "media", cron: "0 4 * * *" }), pol({ volumeName: "cache", enabled: false })]);
    const rows = screen.getAllByText(/Inherits the app schedule|Custom:|Off/).map((e) => e.textContent);
    expect(rows).toEqual(["Inherits the app schedule", "Custom: 0 4 * * *", "Off"]);
  });

  it("interval policies read 'every Nh'", () => {
    show([pol({ volumeName: "data", intervalHours: 6 })]);
    expect(screen.getByText("Custom: every 6h")).toBeTruthy();
  });

  it("Edit opens a modal; saving a custom cron policy PUTs the policy with null for the unused interval", async () => {
    show([]);
    fireEvent.click(screen.getByRole("button", { name: "Edit media" }));
    expect(screen.getByRole("dialog", { name: "Policy for media" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Use a custom schedule for this volume"));
    fireEvent.click(screen.getByLabelText("Cron expression"));
    fireEvent.change(screen.getByLabelText("Max total size (GB)"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(api.putVolumePolicy).toHaveBeenCalled());
    expect(api.putVolumePolicy).toHaveBeenCalledWith("a1", "media", {
      enabled: true, intervalHours: null, cron: "0 3 * * *", retention: null, retentionDays: null, maxSizeGb: 5,
    });
  });

  it("without a custom schedule the policy inherits the app schedule (both null)", async () => {
    show([]);
    fireEvent.click(screen.getByRole("button", { name: "Edit data" }));
    fireEvent.change(screen.getByLabelText("Keep (copies)"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(api.putVolumePolicy).toHaveBeenCalled());
    expect(api.putVolumePolicy).toHaveBeenCalledWith("a1", "data", expect.objectContaining({ intervalHours: null, cron: null, retention: 2 }));
  });

  it("Reset to inherit is offered only where a policy exists and deletes it", async () => {
    show([pol({ volumeName: "media", cron: "0 4 * * *" })]);
    expect(screen.queryByRole("button", { name: "Reset to inherit data" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset to inherit media" }));
    await waitFor(() => expect(api.deleteVolumePolicy).toHaveBeenCalledWith("a1", "media"));
  });
});
