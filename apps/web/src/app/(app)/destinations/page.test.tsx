import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../../i18n/provider";
import { api, ApiError } from "../../../lib/api";
import type { BackupDestination, CreatedDestination } from "../../../lib/types";

vi.mock("../../../components/toast", () => ({ useToast: () => toast }));
const toast = vi.fn();

import DestinationsPage from "./page";

const dest = (over: Partial<BackupDestination> = {}): BackupDestination => ({
  id: "d1", name: "Prod S3", type: "S3", teamId: "t1", s3Bucket: "b", s3Region: null, s3Endpoint: "s3.x", s3Prefix: null,
  encryptionEnabled: true, hasCredentials: true, role: "OWNER", canWrite: true, createdAt: "", ...over,
});

let qc: QueryClient;
const show = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <DestinationsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  window.localStorage.clear();
  toast.mockClear();
  vi.spyOn(api, "listDestinations").mockResolvedValue([dest()]);
  vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team" } as never]);
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe("DestinationsPage", () => {
  it("the Encrypt checkbox defaults ON; unticking shows the cleartext warning", async () => {
    show();
    const box = (await screen.findByLabelText("Encrypt (AES-256)")) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.queryByText(/stored in cleartext/)).toBeNull();
    fireEvent.click(box);
    expect(screen.getByText(/stored in cleartext/)).toBeTruthy();
  });

  it("creating an encrypted destination opens the recovery dialog and keeps the key out of storage and the mutation cache", async () => {
    const created: CreatedDestination = { ...dest({ id: "d2", name: "New" }), recoveryKey: "SECRET-RECOVERY-KEY-123" };
    const create = vi.spyOn(api, "createDestination").mockResolvedValue(created);
    show();
    await screen.findByText("Prod S3");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "b" } });
    fireEvent.change(screen.getByLabelText("Endpoint (s3.amazonaws.com)"), { target: { value: "s3.x" } });
    fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "AK" } });
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "SK" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByTestId("recovery-key")).toBeTruthy();
    expect(create.mock.calls[0][0]).toMatchObject({ encryptionEnabled: true });
    expect(screen.getByTestId("recovery-key").textContent).toBe("SECRET-RECOVERY-KEY-123");
    expect(JSON.stringify(Object.fromEntries(Object.keys(window.localStorage).map((k) => [k, window.localStorage.getItem(k)])))).not.toContain("SECRET-RECOVERY-KEY-123");
    expect(JSON.stringify(qc.getMutationCache().getAll().map((m) => m.state.data))).not.toContain("SECRET-RECOVERY-KEY-123");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(screen.queryByTestId("recovery-key")).toBeNull());
  });

  it("shows an encrypted/unencrypted badge per row", async () => {
    vi.spyOn(api, "listDestinations").mockResolvedValue([dest(), dest({ id: "d3", name: "Old", encryptionEnabled: false })]);
    show();
    expect((await screen.findByTestId("enc-d1")).textContent).toBe("Encrypted");
    expect(screen.getByTestId("enc-d3").textContent).toBe("Not encrypted");
  });

  it("the legacy banner shows for an unencrypted destination and stays dismissed (localStorage)", async () => {
    vi.spyOn(api, "listDestinations").mockResolvedValue([dest({ encryptionEnabled: false })]);
    show();
    expect(await screen.findByText("Some backup storage is not encrypted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Some backup storage is not encrypted")).toBeNull();
    cleanup();
    show();
    await screen.findByText("Prod S3");
    expect(screen.queryByText("Some backup storage is not encrypted")).toBeNull();
  });

  it("the banner still renders when localStorage throws (never required)", async () => {
    vi.spyOn(api, "listDestinations").mockResolvedValue([dest({ encryptionEnabled: false })]);
    const real = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, k: string) {
      if (k.startsWith("tugra.destinations.")) throw new Error("blocked");
      return real.call(this, k);
    });
    show();
    expect(await screen.findByText("Some backup storage is not encrypted")).toBeTruthy();
    spy.mockRestore();
  });

  it("no banner when every destination is encrypted", async () => {
    show();
    await screen.findByText("Prod S3");
    expect(screen.queryByText("Some backup storage is not encrypted")).toBeNull();
  });

  it("Test shows the encryption result (and the gpg-missing message)", async () => {
    vi.spyOn(api, "testDestination").mockResolvedValueOnce({ ok: true, message: "Connection OK", encryption: "OK" });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Connection OK Encryption check passed.", "success"));
    vi.spyOn(api, "testDestination").mockResolvedValueOnce({ ok: false, message: "gpg is not installed on the host", encryption: "FAILED" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("gpg is not installed on the host, so encrypted backups cannot run.", "error"));
  });

  it("delete 409 flow: the conflict message is shown, then the checkbox re-sends with discardBackups", async () => {
    const del = vi.spyOn(api, "deleteDestination")
      .mockRejectedValueOnce(new ApiError(409, "3 backup(s) were encrypted with this destination's key; deleting it destroys the key. Pass ?discardBackups=true to confirm."))
      .mockResolvedValueOnce({ ok: true });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByText(/destroys the key its existing backups need/)).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).find((b) => dialog.contains(b))!);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/3 backup\(s\) were encrypted/);
    expect(del).toHaveBeenLastCalledWith("d1", { discardBackups: false });
    fireEvent.click(screen.getByLabelText("Delete it anyway and discard the backups encrypted with its key"));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).find((b) => dialog.contains(b))!);
    await waitFor(() => expect(del).toHaveBeenLastCalledWith("d1", { discardBackups: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an unencrypted destination deletes without the discard checkbox", async () => {
    vi.spyOn(api, "listDestinations").mockResolvedValue([dest({ encryptionEnabled: false })]);
    const del = vi.spyOn(api, "deleteDestination").mockResolvedValue({ ok: true });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.queryByText(/destroys the key/)).toBeNull();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).find((b) => dialog.contains(b))!);
    await waitFor(() => expect(del).toHaveBeenCalledWith("d1", { discardBackups: false }));
  });
});
