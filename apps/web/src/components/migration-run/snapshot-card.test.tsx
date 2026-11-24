import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import type { MigrationRunView, SnapshotInfo, SnapshotView } from "../../lib/types";

vi.mock("../toast", () => ({ useToast: () => vi.fn() }));

import { SnapshotCard } from "./snapshot-card";

const run = { id: "r1", opId: "op1", dryRun: false, status: "RUNNING" } as unknown as MigrationRunView;
const info = (over: Partial<SnapshotInfo> = {}): SnapshotInfo => ({ status: "SUCCESS", destinationId: "d1", destinationName: "Bucket", destinationType: "S3", items: [], keepDays: 7, capturedAt: "2026-12-01T10:00:00Z", expiresAt: "2026-12-08T10:00:00Z", restoredAt: null, note: null, ...over });
const view = (snapshot: SnapshotInfo | null, destinations: SnapshotView["destinations"] = [{ id: "d1", name: "Bucket", type: "S3" }]): SnapshotView => ({ snapshot, destinations });
const show = (r: MigrationRunView = run) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <I18nProvider><SnapshotCard run={r} /></I18nProvider>
    </QueryClientProvider>,
  );

afterEach(() => { vi.restoreAllMocks(); cleanup(); });
beforeEach(() => { vi.spyOn(api, "getMigrationRunSnapshot").mockResolvedValue(view(null)); });

describe("SnapshotCard", () => {
  it("offers any destination plus the server's own disk, preselecting storage off the box", async () => {
    show();
    const sel = (await screen.findByLabelText("Keep it in")) as HTMLSelectElement;
    expect(sel.value).toBe("d1");
    expect(screen.getByRole("option", { name: "This server's disk" })).toBeTruthy();
    expect(screen.getByText(/AWS S3, Cloudflare R2/)).toBeTruthy();
    expect(screen.queryByText(/MinIO/)).toBeNull();
  });

  it("warns when the server's own disk is chosen and plans with a null destination", async () => {
    const plan = vi.spyOn(api, "planMigrationRunSnapshot").mockResolvedValue(view(info({ status: "PLANNED", destinationId: null, destinationType: "LOCAL", destinationName: null, capturedAt: null, expiresAt: null })));
    show();
    fireEvent.change(await screen.findByLabelText("Keep it in"), { target: { value: "__local__" } });
    expect(screen.getByText(/lost if that disk is/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan the copy" }));
    await waitFor(() => expect(plan).toHaveBeenCalledWith("r1", { destinationId: null, skip: false }));
    expect(await screen.findByText("Your data stays safe during the move.")).toBeTruthy();
  });

  it("starts with only the server's disk when the team has no destination yet", async () => {
    vi.spyOn(api, "getMigrationRunSnapshot").mockResolvedValue(view(null, []));
    show();
    expect(((await screen.findByLabelText("Keep it in")) as HTMLSelectElement).value).toBe("__local__");
  });

  it("shows the finished copy with its keep-until date and a two-step way back per item", async () => {
    vi.spyOn(api, "getMigrationRunSnapshot").mockResolvedValue(view(info({ items: [{ id: "b1", kind: "database", name: "main", status: "SUCCESS", sizeBytes: "2048", error: null }, { id: null, kind: "volume", name: "api / uploads", status: "FAILED", sizeBytes: null, error: "mc: failed" }] })));
    const restore = vi.spyOn(api, "restoreMigrationRunSnapshot").mockResolvedValue(view(info({ restoredAt: "2026-12-02T10:00:00Z" })));
    show();
    expect(await screen.findByText("Your copy is ready")).toBeTruthy();
    expect(screen.getByText("mc: failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go back to this copy" }));
    expect(screen.getByText(/replaces the current data of main/)).toBeTruthy();
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace now" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("r1", "b1"));
  });

  it("a partial or failed copy can be retried", async () => {
    vi.spyOn(api, "getMigrationRunSnapshot").mockResolvedValue(view(info({ status: "PARTIAL" })));
    const go = vi.spyOn(api, "captureMigrationRunSnapshot").mockResolvedValue(view(info()));
    show();
    expect(await screen.findByText("Some items could not be copied")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("r1"));
  });

  it("a finished run offers no new plan", async () => {
    show({ ...run, status: "COMPLETED" } as MigrationRunView);
    expect(await screen.findByText("No safety copy for this move.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan the copy" })).toBeNull();
  });
});
