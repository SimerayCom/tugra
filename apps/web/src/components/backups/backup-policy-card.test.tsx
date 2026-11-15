import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../i18n/provider";
import { BackupPolicyCard, usageFromBackups } from "./backup-policy-card";
import type { BackupDestination, BackupUsage } from "../../lib/types";

afterEach(cleanup);

const dest = (over: Partial<BackupDestination>): BackupDestination => ({
  id: "d1", name: "Prod S3", type: "S3", teamId: "t1", s3Bucket: "b", s3Region: null, s3Endpoint: "s3.x", s3Prefix: null,
  encryptionEnabled: true, hasCredentials: true, role: "OWNER", canWrite: true, createdAt: "", ...over,
});

function show(over: { destinationId?: string; destinations?: BackupDestination[]; usage?: BackupUsage[]; onSave?: () => void; enabled?: boolean; schedule?: { mode: "interval" | "cron"; hours: string; cron: string } } = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <BackupPolicyCard
          enabled={over.enabled ?? true}
          onEnabled={() => undefined}
          schedule={over.schedule ?? { mode: "interval", hours: "24", cron: "" }}
          onSchedule={() => undefined}
          retention={{ keep: "7", days: "", sizeGb: "" }}
          onRetention={() => undefined}
          destinationId={over.destinationId ?? ""}
          onDestination={() => undefined}
          destinations={over.destinations ?? [dest({})]}
          usage={over.usage}
          onSave={over.onSave ?? (() => undefined)}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("BackupPolicyCard", () => {
  it("the implicit server-disk path shows 'Not encrypted (server disk)' with a link to create an encrypted destination", () => {
    show({ destinationId: "" });
    expect(screen.getByTestId("enc-badge").textContent).toBe("Not encrypted (server disk)");
    const link = screen.getByRole("link", { name: "Create an encrypted destination" });
    expect(link.getAttribute("href")).toBe("/destinations");
  });

  it("an encrypted destination shows the encrypted badge and no create-link", () => {
    show({ destinationId: "d1" });
    expect(screen.getByTestId("enc-badge").textContent).toBe("Encrypted (AES-256)");
    expect(screen.queryByRole("link", { name: "Create an encrypted destination" })).toBeNull();
  });

  it("an unencrypted (legacy) destination says 'Not encrypted'", () => {
    show({ destinationId: "d1", destinations: [dest({ encryptionEnabled: false })] });
    expect(screen.getByTestId("enc-badge").textContent).toBe("Not encrypted");
  });

  it("storage meter: used of budget, and the over-budget state + unknown-size note + WAL scope", () => {
    show({ usage: [{ pool: "app", usedBytes: String(12 * 1024 ** 3), backupCount: 3, unknownSizeCount: 2, budgetGb: 10, overBudget: true }] });
    expect(screen.getByText("12 GB of 10 GB used")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/Over budget/);
    expect(screen.getByText("2 backup(s) have no recorded size and are not counted.")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("without a budget it just reports what is used", () => {
    show({ usage: [{ pool: "app", usedBytes: String(2 * 1024 ** 3), backupCount: 4, unknownSizeCount: 0, budgetGb: null, overBudget: false }] });
    expect(screen.getByText("2.0 GB used across 4 backup(s)")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("Save is disabled for an enabled cron schedule with no expression, and fires otherwise", () => {
    const onSave = vi.fn();
    const { unmount } = show({ schedule: { mode: "cron", hours: "24", cron: "" }, onSave });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    show({ onSave });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalled();
  });
});

describe("usageFromBackups", () => {
  it("sums SUCCESS rows, counts unknown sizes, flags over-budget", () => {
    const u = usageFromBackups(
      [
        { status: "SUCCESS", sizeBytes: String(3 * 1024 ** 3) },
        { status: "SUCCESS", sizeBytes: null },
        { status: "FAILED", sizeBytes: String(99 * 1024 ** 3) },
      ],
      2,
    );
    expect(u).toMatchObject({ backupCount: 2, unknownSizeCount: 1, budgetGb: 2, overBudget: true });
    expect(usageFromBackups([], null).overBudget).toBe(false);
  });
});
