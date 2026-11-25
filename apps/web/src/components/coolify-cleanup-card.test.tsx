import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { CleanupView } from "@tugra/shared";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import { ConfirmProvider } from "./confirm";
import { CoolifyCleanupCard } from "./coolify-cleanup-card";

afterEach(cleanup);
const HASH = "ab".repeat(32);
const view = (over: Partial<CleanupView> = {}): CleanupView => ({
  id: "c1",
  serverId: "s1",
  status: "READY",
  completeness: [
    { kind: "application", coolify: 2, tugra: 2, missing: [] },
    { kind: "volume", coolify: 1, tugra: 1, missing: [] },
    { kind: "notification", coolify: 1, tugra: 0, missing: [], notCarried: ["pushover"] },
  ],
  remnants: [
    { kind: "container", name: "coolify-proxy", sizeBytes: null },
    { kind: "image", name: "ghcr.io/coollabsio/sentinel:1", sizeBytes: 5 * 1024 * 1024 },
    { kind: "directory", name: "/data/coolify/backups", sizeBytes: 2048, keep: true, reason: "user_data" },
  ],
  listHash: HASH,
  results: [],
  complete: true,
  failureCode: null,
  confirmedAt: null,
  cleanedAt: null,
  createdAt: "2026-11-26T00:00:00Z",
  ...over,
});

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
});
const show = (props: Partial<React.ComponentProps<typeof CoolifyCleanupCard>> = {}) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <CoolifyCleanupCard serverId="s1" serverName="olgu-box" online {...props} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("CoolifyCleanupCard", () => {
  it("before any check it offers the check and nothing that removes", async () => {
    vi.spyOn(api, "coolifyCleanupLatest").mockResolvedValue(null);
    show();
    await screen.findByRole("button", { name: "Check this server" });
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByText(/Docker volumes are never listed for removal/)).toBeTruthy();
  });

  it("is disabled while the server is offline", async () => {
    vi.spyOn(api, "coolifyCleanupLatest").mockResolvedValue(null);
    show({ online: false });
    expect(((await screen.findByRole("button", { name: "Check this server" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("checking shows the checklist, what will be removed and what is kept with why", async () => {
    vi.spyOn(api, "coolifyCleanupLatest").mockResolvedValue(null);
    const check = vi.spyOn(api, "coolifyCleanupCheck").mockResolvedValue(view());
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Check this server" }));
    await screen.findByText("Everything Coolify had is in Tugra.");
    expect(check).toHaveBeenCalledWith("s1");
    expect(screen.getByText("Ready to clean")).toBeTruthy();
    expect(within(screen.getByTestId("cleanup-row-notification")).getByText("Tugra cannot send these: pushover")).toBeTruthy();
    expect(screen.getByText("coolify-proxy")).toBeTruthy();
    expect(screen.getByText("5.0 MB")).toBeTruthy();
    expect(screen.getByText("/data/coolify/backups")).toBeTruthy();
    expect(screen.getByText("May hold your data")).toBeTruthy();
    expect(screen.getByText("Kept (not removed)")).toBeTruthy();
  });

  it("an incomplete checklist names what is missing and offers no removal", async () => {
    vi.spyOn(api, "coolifyCleanupLatest").mockResolvedValue(
      view({ status: "INCOMPLETE", complete: false, completeness: [{ kind: "domain", coolify: 2, tugra: 1, missing: ["www.example.com"] }, { kind: "volume", coolify: 0, tugra: 0, missing: [], unreadable: true }] }),
    );
    show();
    await screen.findByText("Missing in Tugra: www.example.com");
    expect(screen.getByText("This Coolify read does not say, so it cannot count as complete.")).toBeTruthy();
    expect(screen.getByText("Fix what is missing first. Cleaning stays closed until the list is complete.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("removal needs the server's name typed and quotes the list the owner saw", async () => {
    vi.spyOn(api, "coolifyCleanupLatest").mockResolvedValue(view());
    const confirm = vi.spyOn(api, "coolifyCleanupConfirm").mockResolvedValue(view({ status: "CLEANING" }));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    const go = within(dialog).getByRole("button", { name: "Remove from olgu-box" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(within(dialog).getByText(/removes the 2 items listed/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "olgu-box" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("c1", { confirm: "olgu-box", listHash: HASH }));
  });

  it("cancelling the dialog sends nothing", async () => {
    vi.spyOn(api, "coolifyCleanupLatest").mockResolvedValue(view());
    const confirm = vi.spyOn(api, "coolifyCleanupConfirm").mockResolvedValue(view());
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a list that changed is explained, in words, not as a raw code", async () => {
    vi.spyOn(api, "coolifyCleanupLatest").mockResolvedValue(view());
    vi.spyOn(api, "coolifyCleanupConfirm").mockRejectedValue(new ApiError(409, "the list changed", "list_changed"));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "olgu-box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove from olgu-box" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The list changed. Look at it again.");
  });

  it("shows each removal's result and a failure in words", async () => {
    vi.spyOn(api, "coolifyCleanupLatest").mockResolvedValue(
      view({ status: "FAILED", failureCode: "partial", results: [{ kind: "container", name: "coolify-proxy", code: "ok" }, { kind: "network", name: "coolify", code: "in_use" }] }),
    );
    show();
    await screen.findByText("Removed");
    expect(screen.getByText("Still in use")).toBeTruthy();
    expect(screen.getByText("Some of it could not be removed. Look at the list.")).toBeTruthy();
  });

  it("a server that runs Coolify itself is refused with a plain line", async () => {
    vi.spyOn(api, "coolifyCleanupLatest").mockResolvedValue(null);
    vi.spyOn(api, "coolifyCleanupCheck").mockRejectedValue(new ApiError(409, "x", "control_plane"));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Check this server" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This server runs Coolify itself. It is retired separately.");
  });
});
