import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { api } from "../../../../lib/api";
import { emitToast, subscribeToast } from "../../../../lib/toast-bus";
import type { Backup, Database } from "../../../../lib/types";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "d1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/databases/d1",
  useSearchParams: () => new URLSearchParams("tab=backups"),
}));

import DatabaseDetailPage from "./page";

const DB = {
  id: "d1", name: "main-db", engine: "POSTGRES", status: "RUNNING", canWrite: true, backupSupported: true, backupEnabled: false,
  backupIntervalHours: 24, backupCron: null, backupRetention: 7, backupRetentionDays: null, backupMaxSizeGb: null, backupDestinationId: null,
  verifyEnabled: false, verifyIntervalHours: null, verifyCron: null, tags: [],
} as unknown as Database;

afterEach(cleanup);

let qc: QueryClient;
let toasts: string[];
let off: () => void;
beforeEach(() => {
  // Mirrors lib/providers.tsx: the global cache turns meta.successMessage into a success toast.
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    mutationCache: new MutationCache({
      onSuccess: (_d, _v, _c, m) => {
        const msg = m.meta?.successMessage;
        if (typeof msg === "string" && msg) emitToast(msg, "success");
      },
    }),
  });
  toasts = [];
  off = subscribeToast((x) => toasts.push(x.message));
  vi.spyOn(api, "getDatabase").mockResolvedValue(DB);
  vi.spyOn(api, "listBackups").mockResolvedValue([]);
  vi.spyOn(api, "getBackupUsage").mockResolvedValue({ pools: [] } as never);
  vi.spyOn(api, "listDestinations").mockResolvedValue([]);
  vi.spyOn(api, "listRestores").mockResolvedValue([]);
  vi.spyOn(api, "listDatabases").mockResolvedValue([]);
  vi.spyOn(api, "previewSchedule").mockResolvedValue({ valid: true, timezone: "UTC", nextRuns: [], minGapSeconds: 86400 });
});
afterEach(() => {
  off();
  vi.restoreAllMocks();
});

const show = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <DatabaseDetailPage />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("DatabaseDetailPage — backup feedback", () => {
  it("Backup now toasts the outcome of the finished run", async () => {
    vi.spyOn(api, "backupNow").mockResolvedValue({ id: "b1", status: "SUCCESS" } as Backup);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Backup now" }));
    await waitFor(() => expect(toasts).toContain("Backup completed"));
  });

  it("saving the backup policy toasts", async () => {
    vi.spyOn(api, "setBackupConfig").mockResolvedValue({} as never);
    show();
    fireEvent.click((await screen.findAllByRole("button", { name: "Save" }))[0]);
    await waitFor(() => expect(toasts).toContain("Backup schedule saved"));
  });
});
