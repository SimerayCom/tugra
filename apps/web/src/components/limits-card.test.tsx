import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { LimitsCard } from "./limits-card";
import { api } from "../lib/api";

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const base = { id: "a1", memoryMb: null, cpus: null, reserveMemoryMb: null, reserveCpus: null, memorySwapMb: null, pidsLimit: null, shmSizeMb: null, cpuShares: null, cpusetCpus: null, gpus: null, deployTimeoutSec: null, clusterId: null };

describe("LimitsCard", () => {
  it("gives every field a real accessible name (was placeholder-only)", () => {
    wrap(<LimitsCard {...base} />);
    expect(screen.getByLabelText("Memory (MB)")).toBeTruthy();
    expect(screen.getByLabelText("CPUs")).toBeTruthy();
    expect(screen.getByLabelText(/GPUs/)).toBeTruthy();
    expect(screen.getByLabelText("Deploy timeout (s)")).toBeTruthy();
  });

  it("shows Swarm reservation fields only for a clustered app", () => {
    const { rerender } = wrap(<LimitsCard {...base} />);
    expect(screen.queryByLabelText("Reserved memory (MB)")).toBeNull();
    rerender(<QueryClientProvider client={qc}><I18nProvider><LimitsCard {...base} clusterId="c1" /></I18nProvider></QueryClientProvider>);
    expect(screen.getByLabelText("Reserved memory (MB)")).toBeTruthy();
    expect(screen.getByLabelText("Reserved CPUs")).toBeTruthy();
  });

  it("gates Save until a value changes, then PUTs the parsed limits", async () => {
    const set = vi.spyOn(api, "setAppLimits").mockResolvedValue({ ok: true });
    wrap(<LimitsCard {...base} memoryMb={256} />);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true); // pristine
    fireEvent.change(screen.getByLabelText("Memory (MB)"), { target: { value: "512" } });
    fireEvent.change(screen.getByLabelText("CPUs"), { target: { value: "1.5" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", expect.objectContaining({ memoryMb: 512, cpus: 1.5, gpus: null, deployTimeoutSec: null })));
  });

  it("clears a limit back to null when its field is emptied", async () => {
    const set = vi.spyOn(api, "setAppLimits").mockResolvedValue({ ok: true });
    wrap(<LimitsCard {...base} memoryMb={256} />);
    fireEvent.change(screen.getByLabelText("Memory (MB)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", expect.objectContaining({ memoryMb: null })));
  });

  it("shows the advanced fields for a classic app only, and a clustered save sends nulls for them", async () => {
    const { rerender } = wrap(<LimitsCard {...base} />);
    expect(screen.getByLabelText("Memory + swap (MB)")).toBeTruthy();
    expect(screen.getByLabelText("Max processes")).toBeTruthy();
    expect(screen.getByLabelText("Shared memory (MB)")).toBeTruthy();
    expect(screen.getByLabelText("CPU weight")).toBeTruthy();
    expect(screen.getByLabelText("Pin to CPUs")).toBeTruthy();
    const set = vi.spyOn(api, "setAppLimits").mockResolvedValue({ ok: true });
    rerender(<QueryClientProvider client={qc}><I18nProvider><LimitsCard {...base} clusterId="c1" pidsLimit={50} memoryMb={256} /></I18nProvider></QueryClientProvider>);
    expect(screen.queryByLabelText("Memory + swap (MB)")).toBeNull();
    expect(screen.queryByLabelText("Pin to CPUs")).toBeNull();
    fireEvent.change(screen.getByLabelText("Memory (MB)"), { target: { value: "512" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", expect.objectContaining({ memorySwapMb: null, pidsLimit: null, shmSizeMb: null, cpuShares: null, cpusetCpus: null })));
  });

  it("sends the classic advanced payload (numbers parsed, cpuset trimmed, empties null)", async () => {
    const set = vi.spyOn(api, "setAppLimits").mockResolvedValue({ ok: true });
    wrap(<LimitsCard {...base} memoryMb={256} />);
    fireEvent.change(screen.getByLabelText("Memory + swap (MB)"), { target: { value: "-1" } });
    fireEvent.change(screen.getByLabelText("Max processes"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("CPU weight"), { target: { value: "512" } });
    fireEvent.change(screen.getByLabelText("Pin to CPUs"), { target: { value: " 0-1,3 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", expect.objectContaining({ memoryMb: 256, memorySwapMb: -1, pidsLimit: 100, shmSizeMb: null, cpuShares: 512, cpusetCpus: "0-1,3" })));
  });

  it("disables Save with an inline error for swap without memory, swap below memory, and a bad cpuset", () => {
    wrap(<LimitsCard {...base} />);
    const save = () => screen.getByRole("button", { name: "Save" });
    fireEvent.change(screen.getByLabelText("Memory + swap (MB)"), { target: { value: "512" } });
    expect(screen.getByText("Set a memory limit to use swap.")).toBeTruthy();
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Memory (MB)"), { target: { value: "1024" } });
    expect(screen.getByText("Memory + swap can't be below the memory limit.")).toBeTruthy();
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Memory + swap (MB)"), { target: { value: "-1" } });
    expect(save()).toHaveProperty("disabled", false);
    fireEvent.change(screen.getByLabelText("Pin to CPUs"), { target: { value: "3-1" } });
    expect(screen.getByText("Use CPU numbers or ranges, like 0-3 or 0,2.")).toBeTruthy();
    expect(save()).toHaveProperty("disabled", true);
  });

  it("mirrors the hub ranges for swap and PIDs: Save stays disabled with an inline error instead of a 400", () => {
    wrap(<LimitsCard {...base} memoryMb={4} />);
    const saveBtn = () => screen.getByRole("button", { name: "Save" });
    const swap = screen.getByLabelText("Memory + swap (MB)");
    const pids = screen.getByLabelText("Max processes");
    fireEvent.change(swap, { target: { value: "8" } }); // below 16
    expect(saveBtn()).toHaveProperty("disabled", true);
    expect(screen.getByText("Use -1 (unlimited) or 16 to 1048576 MB.")).toBeTruthy();
    fireEvent.change(swap, { target: { value: "-1" } });
    expect(saveBtn()).toHaveProperty("disabled", false);
    fireEvent.change(pids, { target: { value: "0" } }); // 0 is invalid on the hub
    expect(saveBtn()).toHaveProperty("disabled", true);
    expect(screen.getByText("Use -1 (unlimited) or 1 to 4194304.")).toBeTruthy();
    fireEvent.change(pids, { target: { value: "4194305" } });
    expect(saveBtn()).toHaveProperty("disabled", true);
    fireEvent.change(pids, { target: { value: "-1" } });
    expect(saveBtn()).toHaveProperty("disabled", false);
    fireEvent.change(pids, { target: { value: "100" } });
    expect(saveBtn()).toHaveProperty("disabled", false);
  });
});
