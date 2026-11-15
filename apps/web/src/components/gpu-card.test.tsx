import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { GpuCard, gpuMemoryGb } from "./gpu-card";
import { api, ApiError } from "../lib/api";
import type { GpuDevice, GpuReadiness, GpuReport } from "../lib/types";
import en_servers from "../i18n/locales/en/servers.json";
import en_apps from "../i18n/locales/en/apps.json";

vi.mock("../lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(true) }));
import { copyText } from "../lib/clipboard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const UUID = "GPU-12345678-aaaa-bbbb-cccc-1234567890ab";
const smi: GpuDevice = { index: 0, uuid: UUID, name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", kind: "gpu", memoryMb: 24564, driver: "550.54.15", pci: null, source: "nvidia-smi" };
const pci = (over: Partial<GpuDevice>): GpuDevice => ({ index: null, uuid: null, name: "AMD GPU [1002:73bf]", vendor: "amd", kind: "gpu", memoryMb: null, driver: null, pci: "0000:03:00.0", source: "pci", ...over });

function rep(readiness: GpuReadiness, gpus: GpuDevice[] = [], over: Partial<GpuReport> = {}, invOver: Record<string, unknown> = {}): GpuReport {
  return {
    inventory: readiness === "unknown" ? null : { v: 1, gpus, runtimes: [], defaultRuntime: null, nvidiaRuntime: readiness === "ready", nvidiaDriverLoaded: true, nvidiaModuleVersion: "550.54.15", error: null, ...invOver },
    readiness,
    checkedAt: readiness === "unknown" ? null : new Date(Date.now() - 30_000).toISOString(),
    ageSeconds: readiness === "unknown" ? null : 30,
    stale: false,
    ttlSeconds: 600,
    ...over,
  };
}

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
  vi.mocked(copyText).mockResolvedValue(true);
});

const show = (props: { canOps?: boolean; online?: boolean; serverId?: string } = {}) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <GpuCard serverId={props.serverId ?? "s1"} canOps={props.canOps ?? true} online={props.online ?? true} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("GpuCard", () => {
  it("renders ready with the GPU row (index, name, GB, driver, truncated uuid)", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("ready", [smi]));
    show();
    expect(await screen.findByText("Ready for GPU apps")).toBeTruthy();
    expect(screen.getByText("GPU 0")).toBeTruthy();
    expect(screen.getByText("NVIDIA GeForce RTX 4090")).toBeTruthy();
    expect(screen.getByText("24 GB")).toBeTruthy();
    expect(screen.getByText("Driver 550.54.15")).toBeTruthy();
    expect(screen.getByText("GPU-12345678…90ab")).toBeTruthy();
    expect(screen.getByText(/checked 30s ago/)).toBeTruthy();
  });

  it("renders every readiness state", async () => {
    const cases: [GpuReadiness, GpuDevice[], RegExp][] = [
      ["none", [], /No GPU detected/],
      ["driver_missing", [pci({ vendor: "nvidia", name: "NVIDIA GPU [10de:2684]" })], /NVIDIA GPU found but no driver loaded/],
      ["runtime_missing", [pci({ vendor: "nvidia", name: "N" })], /no NVIDIA runtime registered/],
      ["non_nvidia", [pci({})], /--gpus flag is NVIDIA-only/],
      ["probe_failed", [], /GPU detection didn't complete/],
    ];
    for (const [r, gpus, text] of cases) {
      cleanup();
      qc.clear();
      vi.spyOn(api, "getServerGpus").mockResolvedValue(rep(r, gpus, {}, r === "probe_failed" ? { error: "docker: boom" } : {}));
      show({ canOps: false });
      expect(await screen.findByText(text)).toBeTruthy();
      if (r === "probe_failed") expect(screen.getByText(/docker: boom/)).toBeTruthy();
    }
  });

  it("unknown reads 'Not checked yet' (online) / 'Server is offline'", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("unknown"));
    show({ canOps: false });
    expect(await screen.findByText("Not checked yet")).toBeTruthy();
    cleanup();
    show({ canOps: false, online: false });
    expect(await screen.findByText("Server is offline")).toBeTruthy();
  });

  it("the age text keeps moving", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("ready", [smi], { checkedAt: new Date(Date.now() - 30_000).toISOString() }));
    show({ canOps: false });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByText(/checked 30s ago/)).toBeTruthy());
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText(/checked 1m ago/)).toBeTruthy();
  });

  it("Refresh calls the API and updates the card", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("none"));
    const refresh = vi.spyOn(api, "refreshServerGpus").mockResolvedValue(rep("ready", [smi]));
    show();
    await screen.findByText("No GPU detected");
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(0));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Ready for GPU apps")).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("maps 403 and 503 to their messages", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("none"));
    const refresh = vi.spyOn(api, "refreshServerGpus").mockRejectedValue(new ApiError(403, "forbidden"));
    show();
    await screen.findByText("No GPU detected");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/needs the 'bulk' capability and server-ops permission/)).toBeTruthy();
    refresh.mockRejectedValue(new ApiError(503, "agent offline"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Couldn't reach the server agent")).toBeTruthy();
  });

  it("an automatic refresh that is refused (403) stays silent and is not retried on the next visit; a click still reports", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("unknown"));
    const refresh = vi.spyOn(api, "refreshServerGpus").mockRejectedValue(new ApiError(403, "forbidden"));
    show({ serverId: "s-forbidden" });
    await screen.findByText("Not checked yet");
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    qc.clear();
    show({ serverId: "s-forbidden" });
    await screen.findByText("Not checked yet");
    expect(refresh).toHaveBeenCalledTimes(1); // no second automatic attempt
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/needs the 'bulk' capability and server-ops permission/)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("never auto-refreshes without the servers:ops permission", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("unknown"));
    const refresh = vi.spyOn(api, "refreshServerGpus").mockResolvedValue(rep("ready", [smi]));
    show({ canOps: false, serverId: "s-noops" });
    await screen.findByText("Not checked yet");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("auto-refreshes exactly once for a writer when unknown or stale", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("unknown"));
    const refresh = vi.spyOn(api, "refreshServerGpus").mockResolvedValue(rep("ready", [smi]));
    show();
    expect(await screen.findByText("Ready for GPU apps")).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
    qc.clear();
    refresh.mockClear();
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("none", [], { stale: true }));
    show();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("shows a Stale badge on an old snapshot", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("none", [], { stale: true }));
    show({ canOps: false });
    expect(await screen.findByText("Stale")).toBeTruthy();
  });

  it("never auto-refreshes for a read-only member or an offline server, and Refresh is disabled", async () => {
    const get = vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("none", [], { stale: true }));
    const refresh = vi.spyOn(api, "refreshServerGpus").mockResolvedValue(rep("ready", [smi]));
    show({ canOps: false });
    await screen.findByText("No GPU detected");
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveProperty("disabled", true);
    cleanup();
    qc.clear();
    get.mockResolvedValue(rep("unknown"));
    show({ online: false });
    await screen.findByText("Server is offline");
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveProperty("disabled", true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renders a hostile name as text, never as markup", async () => {
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("ready", [{ ...smi, name: evil }]));
    const { container } = show({ canOps: false });
    expect(await screen.findByText(evil)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("collapses virtual displays under a disclosure", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("none", [pci({ vendor: "other", kind: "virtual", name: "Virtual display [1a03:2000]" })]));
    const { container } = show({ canOps: false });
    expect(await screen.findByText("Virtual displays (1)")).toBeTruthy();
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Virtual display [1a03:2000]");
  });

  it("copies device=<uuid>", async () => {
    vi.spyOn(api, "getServerGpus").mockResolvedValue(rep("ready", [smi]));
    show({ canOps: false });
    fireEvent.click(await screen.findByRole("button", { name: "Copy device flag" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(`device=${UUID}`));
  });

  it("formats memory", () => {
    expect(gpuMemoryGb(24564)).toBe("24");
    expect(gpuMemoryGb(8192)).toBe("8");
    expect(gpuMemoryGb(1536)).toBe("1.5");
  });

  it("every servers.gpus / apps.gpus i18n key the UI uses exists in en", () => {
    const keys = ["title", "checkedAgo", "stale", "refresh", "refreshing", "refreshNeedsWrite", "refreshOffline", "neverChecked", "serverOffline", "none", "ready", "driverMissing", "runtimeMissing", "nonNvidia", "probeFailed", "probeFailedDetail", "gpuLabel", "memory", "driver", "virtualDisplays", "copyFlag", "busy", "errForbidden", "errUnavailable", "errGeneric"];
    for (const k of keys) expect((en_servers.gpus as unknown as Record<string, string>)[k], k).toBeTruthy();
    const appKeys = ["gpusDetected", "gpusNotChecked", "gpusNone", "gpusRedetect", "gpusRedetecting", "gpusSuggest", "gpusAdvice_noGpu", "gpusAdvice_nonNvidia", "gpusAdvice_noDriver", "gpusAdvice_runtimeUnconfirmed", "gpusAdvice_countExceeds", "gpusAdvice_indexOutOfRange", "gpusAdvice_deviceUnknown", "cloneWarn_gpus_unavailable_on_target"];
    for (const k of appKeys) expect((en_apps as unknown as Record<string, string>)[k], k).toBeTruthy();
  });
});
