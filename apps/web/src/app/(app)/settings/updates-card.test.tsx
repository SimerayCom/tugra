import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { InstanceUpdateStatus, PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { UpdatesCard } from "./updates-card";

const STATUS: InstanceUpdateStatus = {
  current: "0.1.0",
  latest: "0.2.0",
  channel: "beta",
  channelSource: "auto",
  updateAvailable: true,
  changelogUrl: "https://get.tugra.io/changelog",
  autoUpdate: false,
  notice: null,
  checksEnabled: true,
  checkIntervalMin: 60,
  lastCheckedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  lastCheckError: null,
};

function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <UpdatesCard />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("UpdatesCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "getInstanceUpdate").mockResolvedValue({ ...STATUS });
    vi.spyOn(api, "updateInstanceUpdate").mockResolvedValue({ ...STATUS, autoUpdate: true });
    vi.spyOn(api, "checkInstanceUpdate").mockResolvedValue({ ...STATUS });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches", () => {
    wrap();
    expect(screen.queryByText("Updates")).toBeNull();
    expect(api.getInstanceUpdate).not.toHaveBeenCalled();
  });

  it("shows the status for the owner (current, latest, update-available badge, changelog)", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    expect(await screen.findByText("Updates")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("0.1.0")).toBeTruthy());
    expect(screen.getByText(/Update available/)).toBeTruthy();
    expect(screen.getByText("View changelog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy(); // in-app updater available
  });

  it("auto channel: shows 'Automatic (Beta)' selected and Save sends updateChannel null", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Updates");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("auto"));
    expect(screen.getByRole("option", { name: "Automatic (Beta)" })).toBeTruthy();
    expect(screen.getByText(/Automatic follows the running build/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    fireEvent.click(screen.getByRole("checkbox")); // enable auto-update
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateInstanceUpdate).toHaveBeenCalledWith({ autoUpdate: true, updateChannel: null }),
    );
  });

  it("selecting Stable sends updateChannel 'stable'", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Updates");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("auto"));
    fireEvent.change(select, { target: { value: "stable" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateInstanceUpdate).toHaveBeenCalledWith({ autoUpdate: false, updateChannel: "stable" }),
    );
  });

  it("explicit pin seeds the pinned channel; switching to Automatic sends null", async () => {
    h.user = { isInstanceOwner: true };
    vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, channel: "stable", channelSource: "explicit" });
    wrap();
    await screen.findByText("Updates");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("stable"));
    fireEvent.change(select, { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateInstanceUpdate).toHaveBeenCalledWith({ autoUpdate: false, updateChannel: null }),
    );
  });

  it("renders the last-checked line, the never-checked state and a failed-check reason", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    expect(await screen.findByText(/Last checked 4m ago/)).toBeTruthy();
    expect(screen.getByText(/Checks run every 60 minutes/)).toBeTruthy();
    cleanup();

    qc.clear();
    vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, latest: null, updateAvailable: false, lastCheckedAt: null });
    wrap();
    await waitFor(() => expect(screen.getAllByText("Not checked yet").length).toBe(2)); // badge + status line
    cleanup();

    qc.clear();
    vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, lastCheckError: "fetch" });
    wrap();
    expect(await screen.findByText(/Last check failed: fetch/)).toBeTruthy();
  });

  it("checksEnabled false: shows the disabled text and disables Check for updates", async () => {
    h.user = { isInstanceOwner: true };
    vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, checksEnabled: false });
    wrap();
    const msg = "Update checks are turned off for this deployment (TUGRA_UPDATE_CHECKS=0).";
    expect(await screen.findByText(msg)).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(msg);
  });

  it("triggers a manual check", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Updates");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(api.checkInstanceUpdate).toHaveBeenCalled());
  });

  it("keeps unsaved channel edits when a manual check refreshes the status (no clobber)", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Updates");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("auto"));
    fireEvent.change(select, { target: { value: "stable" } }); // unsaved edit
    // the check discovers a newer version → refetch changes `data` identity
    vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, latest: "0.9.0" });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByText(/0\.9\.0/)).toBeTruthy()); // display refreshed
    expect(select.value).toBe("stable"); // ...but the unsaved edit survives
  });

  it("Update now: POST → SSE progress → reconcile on the new version → 'Updated to X'", async () => {
    h.user = { isInstanceOwner: true };
    // getInstanceUpdate now reports the running version AS the target, so the reconcile poll resolves.
    vi.spyOn(api, "getInstanceUpdate").mockResolvedValue({ ...STATUS, current: "0.2.0" });
    vi.spyOn(api, "applyInstanceUpdate").mockResolvedValue({ status: "started", targetVersion: "0.2.0" });
    const savedFetch = global.fetch;
    global.fetch = vi.fn(async () =>
      sseResponse(['{"phase":"pulling","targetVersion":"0.2.0"}', '{"phase":"recreating","targetVersion":"0.2.0"}']),
    ) as unknown as typeof fetch;
    try {
      wrap();
      fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
      await waitFor(() => expect(api.applyInstanceUpdate).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText(/Updated to 0\.2\.0/)).toBeTruthy());
    } finally {
      global.fetch = savedFetch;
    }
  });

  it("Update now that returns a non-started status shows a message and opens no stream", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "applyInstanceUpdate").mockResolvedValue({ status: "notify-only", targetVersion: "1.3.0" });
    const fetchSpy = vi.spyOn(global, "fetch");
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => expect(screen.getByText(/minor\/major release/)).toBeTruthy());
    expect(fetchSpy).not.toHaveBeenCalled(); // no SSE stream opened
  });

  it("reconciles via the version poll even if the SSE never terminates (stalled sidecar)", async () => {
    vi.useFakeTimers();
    const savedFetch = global.fetch;
    try {
      h.user = { isInstanceOwner: true };
      vi.spyOn(api, "getInstanceUpdate").mockResolvedValue({ ...STATUS, current: "0.2.0" }); // reconcile sees target
      vi.spyOn(api, "applyInstanceUpdate").mockResolvedValue({ status: "started", targetVersion: "0.2.0" });
      // A stream that never closes: consumeSseStream hangs forever, so ONLY the client-side cap can advance.
      global.fetch = vi.fn(
        async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
      ) as unknown as typeof fetch;

      wrap();
      await act(async () => { await vi.advanceTimersByTimeAsync(50); }); // owner query resolves -> button renders
      fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      // Advance past the SSE cap: the race resolves via the timeout, reconcile polls, current===target -> done.
      await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 100); });
      expect(screen.getByText(/Updated to 0\.2\.0/)).toBeTruthy();
    } finally {
      global.fetch = savedFetch;
      vi.useRealTimers();
    }
  });

  it("hides the Update now button when up to date", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getInstanceUpdate").mockResolvedValue({ ...STATUS, updateAvailable: false });
    wrap();
    await screen.findByText("Updates");
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
  });
});
