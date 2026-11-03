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

const base = { id: "a1", memoryMb: null, cpus: null, reserveMemoryMb: null, reserveCpus: null, gpus: null, deployTimeoutSec: null, clusterId: null };

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
});
