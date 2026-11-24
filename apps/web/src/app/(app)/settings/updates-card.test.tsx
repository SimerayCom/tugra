import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import { subscribeToast, type ToastInput } from "../../../lib/toast-bus";
import type { InstanceUpdateStatus, PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { UpdatesCard } from "./updates-card";

const STATUS: InstanceUpdateStatus = {
  // a prerelease build, so "Automatic" resolves to Beta (the label follows the build, not the current pin)
  current: "0.1.0-beta.16",
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
  updater: { version: null, behind: false, state: "unknown", checkedAt: null },
  halfUpdate: null,
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
    await waitFor(() => expect(screen.getByText("0.1.0-beta.16")).toBeTruthy());
    expect(screen.getByText(/Update available/)).toBeTruthy();
    expect(screen.getByText("View changelog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy(); // in-app updater available
  });

  describe("update helper (tugra-updater) version", () => {
    const withUpdater = (updater: InstanceUpdateStatus["updater"]) => vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, updater });

    it("shows nothing when the hub has not seen the helper (or an older hub sends no field)", async () => {
      h.user = { isInstanceOwner: true };
      wrap();
      await screen.findByText("Updates");
      expect(screen.queryByTestId("updater-status")).toBeNull();
      expect(screen.queryByTestId("updater-notice")).toBeNull();
      cleanup();
      qc.clear();
      vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, updater: undefined as never });
      wrap();
      await screen.findByText("Updates");
      expect(screen.queryByTestId("updater-status")).toBeNull();
    });

    it("an up-to-date helper shows its version with an Up to date badge and no notice", async () => {
      h.user = { isInstanceOwner: true };
      withUpdater({ version: "0.1.0-beta.16", behind: false, state: "current", checkedAt: new Date().toISOString() });
      wrap();
      const row = await screen.findByTestId("updater-status");
      expect(row.textContent).toContain("Update helper");
      expect(row.textContent).toContain("0.1.0-beta.16");
      expect(row.textContent).toContain("Up to date");
      expect(screen.queryByTestId("updater-notice")).toBeNull();
    });

    it("a helper that lags the hub says so, and that the hub updates it by itself", async () => {
      h.user = { isInstanceOwner: true };
      withUpdater({ version: "0.1.0-beta.12", behind: true, state: "behind", checkedAt: new Date().toISOString() });
      wrap();
      const row = await screen.findByTestId("updater-status");
      expect(row.textContent).toContain("0.1.0-beta.12");
      expect(row.textContent).toContain("Behind");
      const note = screen.getByTestId("updater-notice");
      expect(note.textContent).toContain("runs 0.1.0-beta.12");
      expect(note.textContent).toContain("updates it by itself");
    });

    it("while the refresh is scheduled it says Refreshing; when it did not converge it points at the installer", async () => {
      h.user = { isInstanceOwner: true };
      withUpdater({ version: "0.1.0-beta.12", behind: true, state: "refreshing", checkedAt: null });
      wrap();
      expect((await screen.findByTestId("updater-status")).textContent).toContain("Refreshing");
      expect(screen.getByTestId("updater-notice").textContent).toContain("restarts in a few seconds");
      cleanup();
      qc.clear();
      withUpdater({ version: "0.1.0-beta.12", behind: true, state: "failed", checkedAt: null });
      wrap();
      await screen.findByTestId("updater-status");
      expect(screen.getByTestId("updater-notice").textContent).toContain("Run scripts/install.sh on the server once");
    });
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

  it("manual check toasts the result: up to date, update available, and the failure reason", async () => {
    h.user = { isInstanceOwner: true };
    const toasts: ToastInput[] = [];
    const off = subscribeToast((t) => toasts.push(t));
    try {
      wrap();
      await screen.findByText("Updates");
      const click = () => fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

      vi.mocked(api.checkInstanceUpdate).mockResolvedValue({ ...STATUS, updateAvailable: false, latest: "0.1.0" });
      click();
      await waitFor(() => expect(toasts).toHaveLength(1));
      expect(toasts[0]).toMatchObject({ message: "Up to date (v0.1.0-beta.16)", type: "success" });

      vi.mocked(api.checkInstanceUpdate).mockResolvedValue({ ...STATUS, updateAvailable: true, latest: "0.2.0" });
      click();
      await waitFor(() => expect(toasts).toHaveLength(2));
      expect(toasts[1]).toMatchObject({ message: "v0.2.0 available", type: "info" });

      vi.mocked(api.checkInstanceUpdate).mockResolvedValue({ ...STATUS, lastCheckError: "fetch" });
      click();
      await waitFor(() => expect(toasts).toHaveLength(3));
      expect(toasts[2]).toMatchObject({ message: "Update check failed: fetch", type: "error" });
    } finally {
      off();
    }
  });

  it("saving carries the success-toast meta (shown by the global MutationCache)", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("Updates");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateInstanceUpdate).toHaveBeenCalled());
    const metas = qc.getMutationCache().getAll().map((m) => m.meta?.successMessage);
    expect(metas).toContain("Update settings saved");
  });

  it("Update now shows the 4-step stepper, hides the button for the whole run, then offers Reload", async () => {
    h.user = { isInstanceOwner: true };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const savedFetch = global.fetch;
    const toasts: ToastInput[] = [];
    const off = subscribeToast((t) => toasts.push(t));
    try {
      let status = { ...STATUS, current: "0.1.0" };
      vi.spyOn(api, "getInstanceUpdate").mockImplementation(async () => ({ ...status }));
      vi.spyOn(api, "applyInstanceUpdate").mockResolvedValue({ status: "started", targetVersion: "0.2.0" });
      // SSE that reports `pulling` then stays open until aborted.
      global.fetch = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"phase":"pulling"}\n\n'));
            // closes after the hub "restarts"
            setTimeout(() => c.close(), 5000);
          },
        });
        return new Response(stream, { status: 200 });
      }) as unknown as typeof fetch;

      wrap();
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

      const li = (id: string) => screen.getByTestId("update-progress").querySelector(`[data-step="${id}"]`)!;
      expect(screen.getByText("Updating to 0.2.0")).toBeTruthy();
      expect(li("queued").getAttribute("data-state")).toBe("done");
      expect(li("pulling").getAttribute("data-state")).toBe("active");
      expect(li("recreating").getAttribute("data-state")).toBe("pending");
      expect(screen.queryByRole("button", { name: "Update now" })).toBeNull(); // no double-fire
      expect(screen.getByTestId("update-elapsed").textContent).toBe("Elapsed 00:01");

      // stream drops (hub restarting) → reconnecting; version still old
      await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
      expect(li("reconnecting").getAttribute("data-state")).toBe("active");
      expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();

      status = { ...status, current: "0.2.0" };
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
      expect(screen.getByTestId("update-progress").querySelectorAll('[data-state="done"]')).toHaveLength(4);
      expect(screen.getByText(/Updated to 0\.2\.0/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
      expect(screen.getByText(/still running the old version/)).toBeTruthy();
      expect(toasts.some((x) => x.message.startsWith("Updated to 0.2.0") && x.type === "success")).toBe(true);
      // the elapsed counter froze at the end
      const frozen = screen.getByTestId("update-elapsed").textContent;
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByTestId("update-elapsed").textContent).toBe(frozen);
    } finally {
      off();
      global.fetch = savedFetch;
      vi.useRealTimers();
    }
  });

  it("a terminal failure marks the step that was running red and shows the existing message", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "applyInstanceUpdate").mockResolvedValue({ status: "started", targetVersion: "0.2.0" });
    const savedFetch = global.fetch;
    global.fetch = vi.fn(async () => sseResponse(['{"phase":"pulling"}', '{"phase":"failed"}'])) as unknown as typeof fetch;
    try {
      wrap();
      fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
      await waitFor(() => expect(screen.getByText(/The update failed\. Check the server logs/)).toBeTruthy());
      const prog = screen.getByTestId("update-progress");
      expect(prog.querySelector('[data-step="pulling"]')!.getAttribute("data-state")).toBe("failed");
      expect(prog.querySelector('[data-step="queued"]')!.getAttribute("data-state")).toBe("done");
      expect(prog.querySelector('[data-step="recreating"]')!.getAttribute("data-state")).toBe("pending");
      expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy(); // a failed run may be retried
    } finally {
      global.fetch = savedFetch;
    }
  });
  describe("why an update failed, and a half-finished update", () => {
    const failWith = async (frames: string[]) => {
      h.user = { isInstanceOwner: true };
      vi.spyOn(api, "applyInstanceUpdate").mockResolvedValue({ status: "started", targetVersion: "0.2.0" });
      const savedFetch = global.fetch;
      global.fetch = vi.fn(async () => sseResponse(frames)) as unknown as typeof fetch;
      try {
        wrap();
        fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
        return await screen.findByTestId("update-failure");
      } finally {
        global.fetch = savedFetch;
      }
    };

    it("a disk-preflight refusal shows the numbers, the path and the remedy (not just 'failed')", async () => {
      const el = await failWith([
        '{"phase":"pulling","targetVersion":"0.2.0"}',
        JSON.stringify({
          phase: "failed",
          targetVersion: "0.2.0",
          error: "not enough free disk space: needs about 20.0 GB free on /var/lib/docker, has 5.0 GB",
          code: "disk_space",
          needBytes: 21474836480,
          haveBytes: 5368709120,
          path: "/var/lib/docker",
        }),
      ]);
      expect(el.getAttribute("data-code")).toBe("disk_space");
      expect(el.textContent).toContain("about 20.0 GB free on /var/lib/docker");
      expect(el.textContent).toContain("only 5.0 GB is available");
      expect(el.textContent).toMatch(/Free some space .*click Update now again\. Nothing was changed\./);
      expect(el.textContent).not.toMatch(/^The update failed\. Check the server logs/);
      expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy(); // retry once space is freed
    });

    it("a disk that filled up while pulling (no numbers) says so", async () => {
      const el = await failWith(['{"phase":"failed","error":"the disk filled up while pulling the images","code":"disk_space"}']);
      expect(el.textContent).toContain("The disk filled up while pulling the images");
    });

    it("any other cause the helper reports is quoted instead of a bare 'update failed'", async () => {
      const el = await failWith(['{"phase":"failed","error":"image pull failed: manifest unknown"}']);
      expect(el.textContent).toBe("The update failed: image pull failed: manifest unknown");
    });

    it("a failure with no reported cause at all keeps the generic text", async () => {
      const el = await failWith(['{"phase":"failed"}']);
      expect(el.textContent).toMatch(/The update failed\. Check the server logs/);
    });

    it("a detected half state is explained and offers 'Finish update' (instead of 'Update now'); it starts the same update", async () => {
      h.user = { isInstanceOwner: true };
      vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, halfUpdate: { envVersion: "0.2.0", runningVersion: "0.1.0-beta.16" } });
      const apply = vi.spyOn(api, "applyInstanceUpdate").mockResolvedValue({ status: "up-to-date", targetVersion: "0.2.0" });
      wrap();
      const note = await screen.findByTestId("update-half-note");
      expect(note.textContent).toContain("An earlier update did not finish");
      expect(note.textContent).toContain("names 0.2.0");
      expect(note.textContent).toContain("still running 0.1.0-beta.16");
      expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Finish update" }));
      await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    });

    it("a half state with no newer release to finish it explains the manual fix and offers no button", async () => {
      h.user = { isInstanceOwner: true };
      vi.mocked(api.getInstanceUpdate).mockResolvedValue({ ...STATUS, updateAvailable: false, halfUpdate: { envVersion: "0.2.0", runningVersion: "0.1.0-beta.16" } });
      wrap();
      const note = await screen.findByTestId("update-half-note");
      expect(note.textContent).toContain("Set TUGRA_VERSION=0.1.0-beta.16");
      expect(screen.queryByRole("button", { name: "Finish update" })).toBeNull();
    });

    it("no half state, no note", async () => {
      h.user = { isInstanceOwner: true };
      wrap();
      await screen.findByRole("button", { name: "Update now" });
      expect(screen.queryByTestId("update-half-note")).toBeNull();
    });
  });
});
