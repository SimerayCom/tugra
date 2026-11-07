import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { BackupRunModal, type BackupRun } from "./backup-run-modal";

afterEach(cleanup);

const base: BackupRun = {
  id: "b1",
  status: "SUCCESS",
  filename: "dump.sql.gz",
  sizeBytes: "1572864",
  durationMs: 42_000,
  exitCode: 0,
  errorTail: null,
  destinationType: null,
  createdBy: "scheduler",
  createdAt: "2026-11-07T10:00:00.000Z",
  completedAt: "2026-11-07T10:00:42.000Z",
};

function show(run: Partial<BackupRun>, exportUrl = vi.fn(), destinationName?: string | null) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <BackupRunModal run={{ ...base, ...run }} destinationName={destinationName} exportUrl={exportUrl} onClose={() => undefined} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return exportUrl;
}

describe("BackupRunModal", () => {
  it("shows status, size, duration, exit code, destination and who triggered it", () => {
    show({}, vi.fn(), "Prod S3");
    expect(screen.getByText("SUCCESS")).toBeTruthy();
    expect(screen.getByText("1.5 MB")).toBeTruthy();
    expect(screen.getByText("42s")).toBeTruthy();
    expect(screen.getByText("Prod S3")).toBeTruthy();
    expect(screen.getByText("Scheduler")).toBeTruthy();
    expect(screen.getByText("dump.sql.gz")).toBeTruthy();
  });

  it("a FAILED run shows its failure reason (errorTail)", () => {
    show({ status: "FAILED", errorTail: "pg_dump: error: connection refused", exitCode: 1, sizeBytes: null });
    expect(screen.getByText("Failure reason")).toBeTruthy();
    expect(screen.getByText("pg_dump: error: connection refused")).toBeTruthy();
  });

  it("a FAILED run without an errorTail (read-only viewer / none recorded) says so instead of looking empty", () => {
    show({ status: "FAILED", errorTail: null });
    expect(screen.getByText("No error output was recorded for this run.")).toBeTruthy();
  });

  it("a LOCAL success explains why there is no download button", () => {
    show({ destinationType: "LOCAL" });
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.getByText(/stored on the server's local disk/)).toBeTruthy();
  });

  it("an S3 success generates a presigned download link on demand", async () => {
    const exportUrl = vi.fn().mockResolvedValue({ url: "https://s3.example/dl?sig=1", expiresAt: "2026-11-08T00:00:00Z" });
    show({ destinationType: "S3" }, exportUrl);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Open download link" })).toBeTruthy());
    expect(exportUrl).toHaveBeenCalledWith("b1");
    expect(screen.getByRole("link", { name: "Open download link" }).getAttribute("href")).toBe("https://s3.example/dl?sig=1");
  });

  it("surfaces a failed link generation", async () => {
    show({ destinationType: "S3" }, vi.fn().mockRejectedValue(new Error("boom")));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByText("Could not generate a download link")).toBeTruthy();
  });

  it("includes the volume name for a volume backup run", () => {
    show({ volumeName: "pgdata" });
    expect(screen.getByText("pgdata")).toBeTruthy();
  });
});
