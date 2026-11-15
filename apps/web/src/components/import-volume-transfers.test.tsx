import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { ImportVolumeTransfers } from "./import-volume-transfers";
import { api } from "../lib/api";
import type { OpVolumes, VolumeTransferView } from "../lib/types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const GiB = 1024 ** 3;
const REF = "volume:srv1:5f3a9c:data";
const vol = (o: Partial<VolumeTransferView> = {}): VolumeTransferView => ({
  itemRef: REF, resourceName: "web", mountPath: "/var/www/data", destType: "app-volume", destVolume: "data", state: "NONE", phase: null,
  partsDone: 0, bytesDone: 0, rawBytesDone: 0, rawBytesTotal: null, bps: null, etaSec: null, inventory: null, diskVerdict: null, gates: null,
  evidenceNote: "reported by the migrator", excluded: null, error: null, steps: [], canAbort: false, canReset: false, ...o,
});
const data = (volumes: VolumeTransferView[], enabled = true): OpVolumes => ({ volumes, tokenExpiresAt: null, enabled });
const inv = { found: true, rawBytes: 5 * GiB, entries: 120, mountType: "volume" as const, running: false, exitCode: 0, specials: { sockets: 0, fifos: 0, devices: 0 } };

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => vi.restoreAllMocks());

describe("ImportVolumeTransfers", () => {
  it("shows progress, bytes, parts, speed, ETA and the phase of a copying volume, with an accessible progress bar", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([vol({ state: "COPYING", phase: "streaming", partsDone: 12, bytesDone: 400, rawBytesDone: 2 * GiB, rawBytesTotal: 5 * GiB, bps: 25 * 1024 ** 2, etaSec: 7200, inventory: inv, canAbort: true, canReset: true })]));
    wrap(<ImportVolumeTransfers opId="op1" />);
    const bar = await screen.findByRole("progressbar", { name: "Copy progress of web" });
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(screen.getByTestId("vx-state").textContent).toBe("Copying");
    expect(screen.getByText("2.0 GiB of 5.0 GiB")).toBeTruthy();
    expect(screen.getByText("12 parts")).toBeTruthy();
    expect(screen.getByText("25 MiB/s")).toBeTruthy();
    expect(screen.getByText("about 2 h 00 min left")).toBeTruthy();
    expect(screen.getByText("Sending parts")).toBeTruthy();
    expect(screen.getAllByText("reported by the migrator").length).toBeGreaterThan(0); // evidence label
  });

  it("an unknown total shows the copied size without a percentage bar", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([vol({ state: "COPYING", rawBytesDone: GiB, rawBytesTotal: null })]));
    wrap(<ImportVolumeTransfers opId="op1" />);
    await screen.findByText("1.0 GiB copied");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("DONE is 100 %, FAILED shows the explanation of the hub's literal and an alert; unknown text is shown as is", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(
      data([
        vol({ itemRef: "volume:s:a:one", resourceName: "one", state: "DONE", rawBytesDone: 5, rawBytesTotal: 5 }),
        vol({ itemRef: "volume:s:a:two", resourceName: "two", state: "FAILED", rawBytesDone: 1, rawBytesTotal: 5, error: "vx-diverged", canReset: true }),
        vol({ itemRef: "volume:s:a:three", resourceName: "three", state: "FAILED", error: "some brand new failure text", canReset: true }),
      ]),
    );
    wrap(<ImportVolumeTransfers opId="op1" />);
    const one = await screen.findByRole("progressbar", { name: "Copy progress of one" });
    expect(one.getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("The source no longer matches the parts already copied. Reset the volume to start over.")).toBeTruthy();
    expect(screen.getByText("some brand new failure text")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it("abort asks for confirmation, then aborts exactly that volume", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([vol({ state: "COPYING", canAbort: true, canReset: true, rawBytesTotal: 10, rawBytesDone: 1 })]));
    const abort = vi.spyOn(api, "abortOpVolume").mockResolvedValue({ state: "ABORTED" });
    wrap(<ImportVolumeTransfers opId="op1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Abort" }));
    await screen.findByText("Abort this copy?");
    expect(abort).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(abort).toHaveBeenCalledWith("op1", REF));
  });

  it("cancelling the abort dialog does nothing", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([vol({ state: "COPYING", canAbort: true, rawBytesTotal: 10, rawBytesDone: 1 })]));
    const abort = vi.spyOn(api, "abortOpVolume").mockResolvedValue({ state: "ABORTED" });
    wrap(<ImportVolumeTransfers opId="op1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Abort" }));
    await screen.findByText("Abort this copy?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Abort this copy?")).toBeNull());
    expect(abort).not.toHaveBeenCalled();
  });

  it("reset (a failed volume reads Retry) confirms before wiping, then resets", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([vol({ state: "FAILED", canReset: true, error: "vx-diverged" })]));
    const reset = vi.spyOn(api, "resetOpVolume").mockResolvedValue({ state: "PENDING", attempt: 2 });
    wrap(<ImportVolumeTransfers opId="op1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Start this volume over?");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith("op1", REF));
  });

  it("excluding a volume needs the explicit acknowledgement; without it nothing is sent", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([vol({ state: "NONE" })]));
    const exclude = vi.spyOn(api, "excludeOpVolume").mockResolvedValue({ itemRef: REF, excluded: true });
    wrap(<ImportVolumeTransfers opId="op1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Do not migrate" }));
    await screen.findByText("Leave this volume out?");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" })); // without ticking the box
    await waitFor(() => expect(screen.queryByText("Leave this volume out?")).toBeNull());
    expect(exclude).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Do not migrate" }));
    await screen.findByText("Leave this volume out?");
    fireEvent.click(screen.getByLabelText("I understand this volume's data will not be migrated."));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(exclude).toHaveBeenCalledWith("op1", REF));
  });

  it("an excluded volume reads `Not migrated` with its reason and can be re-included", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([vol({ state: "EXCLUDED", excluded: { reason: "58 GB ClickHouse" } })]));
    const include = vi.spyOn(api, "includeOpVolume").mockResolvedValue({ itemRef: REF, excluded: false });
    wrap(<ImportVolumeTransfers opId="op1" />);
    expect((await screen.findByTestId("vx-state")).textContent).toBe("Not migrated");
    expect(screen.getByText("58 GB ClickHouse")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Migrate again" }));
    await waitFor(() => expect(include).toHaveBeenCalledWith("op1", REF));
  });

  it("renders nothing when the hub has the streamed copy off, and an empty note when there is no volume", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValueOnce(data([], false));
    const { container } = wrap(<ImportVolumeTransfers opId="op1" />);
    await waitFor(() => expect(api.getOpVolumes).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
    cleanup();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([]));
    wrap(<ImportVolumeTransfers opId="op2" />);
    await screen.findByText("No volume of this import has data to copy.");
  });

  it("polls every 3 s while a copy is live, every 15 s otherwise, and stops when unmounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([vol({ state: "COPYING", rawBytesTotal: 10, rawBytesDone: 1 })]));
    const view = wrap(<ImportVolumeTransfers opId="op1" />);
    await screen.findByTestId("vx-state");
    const first = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3100);
    expect(spy.mock.calls.length).toBeGreaterThan(first);
    const live = spy.mock.calls.length;
    view.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy.mock.calls.length).toBe(live); // nothing after unmount

    cleanup();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy2 = vi.spyOn(api, "getOpVolumes").mockResolvedValue(data([vol({ state: "DONE", rawBytesTotal: 10, rawBytesDone: 10 })]));
    spy2.mockClear();
    wrap(<ImportVolumeTransfers opId="op3" />);
    await screen.findByTestId("vx-state");
    const calm = spy2.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy2.mock.calls.length).toBe(calm); // 15 s cadence: nothing within 5 s
  });
});

describe("dry-run inventory (preflight table)", () => {
  it("lists what was found: size, stopped + exit code, disk verdict with numbers, the estimate label and the evidence note", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(
      data([vol({ inventory: inv, diskVerdict: { ok: true, unknown: false, details: { totalBytes: 5 * GiB, targetStagingFreeBytes: 200 * GiB, targetDockerFreeBytes: 150 * GiB, targetSameDevice: true } } })]),
    );
    wrap(<ImportVolumeTransfers opId="op1" />);
    await screen.findByText("What the migrator found");
    expect(screen.getByText(/5\.0 GiB in 120 entries/)).toBeTruthy();
    expect(screen.getByText(/Stopped \(exit code 0\)/)).toBeTruthy();
    expect(screen.getByText(/The target has enough free space \(150 GiB free, about 12 GiB needed\)/)).toBeTruthy();
    expect(screen.getByText(/share one disk/)).toBeTruthy();
    expect(screen.getByText(/size divided by the measured link speed/)).toBeTruthy();
    expect(screen.getByText(/The source's state \(stopped, size, image\) comes from the migrator/)).toBeTruthy();
  });

  it("variants: not found, no inventory yet, running, bind, devices, sockets, short and unknown disk", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(
      data([
        vol({ itemRef: "volume:s:a:nf", resourceName: "nf", inventory: { ...inv, found: false } }),
        vol({ itemRef: "volume:s:a:ni", resourceName: "ni", gates: [{ id: "inventory", status: "unknown", text: "run the dry run" }] }),
        vol({ itemRef: "volume:s:a:rn", resourceName: "rn", inventory: { ...inv, running: true, mountType: "bind", specials: { sockets: 2, fifos: 0, devices: 1 } }, diskVerdict: { ok: false, unknown: false, details: { totalBytes: 5 * GiB, targetStagingFreeBytes: GiB, targetDockerFreeBytes: GiB } } }),
        vol({ itemRef: "volume:s:a:uk", resourceName: "uk", inventory: inv, diskVerdict: { ok: false, unknown: true, details: { reason: "offline" } } }),
      ]),
    );
    wrap(<ImportVolumeTransfers opId="op1" />);
    await screen.findByText("Not found on the source");
    expect(screen.getByText("Run the dry run command on the source host to measure this volume.", { exact: false })).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText(/Host bind mount: refused unless the migrator runs with --allow-bind/)).toBeTruthy();
    expect(screen.getByText("2 socket(s) are not copied")).toBeTruthy();
    expect(screen.getByText("1 device node(s): the copy is refused")).toBeTruthy();
    expect(screen.getByText(/The target does not have enough free space/)).toBeTruthy();
    expect(screen.getByText(/free space could not be read/)).toBeTruthy();
  });

  it("a Postgres volume shows image/major/layout/mount and every gate with its mark AND the hub's exact sentence", async () => {
    vi.spyOn(api, "getOpVolumes").mockResolvedValue(
      data([
        vol({
          itemRef: "volume:s:pg:data", resourceName: "pg", destType: "db-data", mountPath: "/var/lib/postgresql/data",
          inventory: { ...inv, image: "postgres:18-alpine", pgMajor: "18", pgLayout: "nested", mountDest: "/var/lib/postgresql" },
          gates: [
            { id: "credentials", status: "pass", text: "the source credentials were carried" },
            { id: "layout", status: "fail", text: "PostgreSQL 18 data layout is not supported by Tugra database volumes yet" },
            { id: "quiesced", status: "unknown", text: "the source has not been inspected yet" },
          ],
        }),
      ]),
    );
    wrap(<ImportVolumeTransfers opId="op1" />);
    await screen.findByText("Image postgres:18-alpine");
    expect(screen.getByText("PostgreSQL 18")).toBeTruthy();
    expect(screen.getByText("Data layout: nested")).toBeTruthy();
    expect(screen.getByText("Mounted at /var/lib/postgresql")).toBeTruthy();
    const group = screen.getByRole("group", { name: "Checks for a physical copy" });
    expect(within(group).getByText("PostgreSQL 18 data layout is not supported by Tugra database volumes yet")).toBeTruthy();
    expect(within(group).getByText("the source credentials were carried")).toBeTruthy();
    expect(within(group).getByText("failed")).toBeTruthy(); // screen-reader status, not colour alone
    expect(within(group).getByText("not checked yet")).toBeTruthy();
  });
});
