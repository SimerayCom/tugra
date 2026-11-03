import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { HealthCheckCard } from "./health-check-card";
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

const base = { id: "a1", healthCheckType: null, healthCheckPath: null, healthCheckPort: null, healthCheckMethod: null, healthCheckScheme: null, healthCheckResponseText: null, healthCmd: null, timings: { interval: null, timeout: null, retries: null, startPeriod: null, expectedStatus: null } };

describe("HealthCheckCard", () => {
  it("labels the HTTP path and port fields (were placeholder-only)", () => {
    wrap(<HealthCheckCard {...base} healthCheckType="HTTP" />);
    expect(screen.getByLabelText(/Path/)).toBeTruthy();
    expect(screen.getByLabelText("Port")).toBeTruthy();
    expect(screen.getByLabelText("Interval (s)")).toBeTruthy(); // timings shown for a non-NONE check
  });

  it("labels the command field for a CMD check", () => {
    wrap(<HealthCheckCard {...base} healthCheckType="CMD" />);
    expect(screen.getByLabelText(/Health check command/)).toBeTruthy();
  });

  it("hides the timings for a NONE check", () => {
    wrap(<HealthCheckCard {...base} healthCheckType="NONE" />);
    expect(screen.queryByLabelText("Interval (s)")).toBeNull();
  });

  it("shows Scheme + Method only for an HTTP check, and PUTs the chosen values", async () => {
    const set = vi.spyOn(api, "setAppHealthCheck").mockResolvedValue({ ok: true });
    wrap(<HealthCheckCard {...base} healthCheckType="HTTP" healthCheckPath="/health" />);
    const scheme = screen.getByLabelText("Scheme");
    const method = screen.getByLabelText("Method");
    fireEvent.change(scheme, { target: { value: "https" } });
    fireEvent.change(method, { target: { value: "POST" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", expect.objectContaining({ type: "HTTP", scheme: "https", method: "POST" })));
  });

  it("hides Scheme + Method for a CMD check (HTTP-only fields)", () => {
    wrap(<HealthCheckCard {...base} healthCheckType="CMD" />);
    expect(screen.queryByLabelText("Scheme")).toBeNull();
    expect(screen.queryByLabelText("Method")).toBeNull();
    expect(screen.queryByLabelText(/Response text/)).toBeNull();
  });

  it("sends the response text for an HTTP check and null when blank", async () => {
    const set = vi.spyOn(api, "setAppHealthCheck").mockResolvedValue({ ok: true });
    const { rerender } = wrap(<HealthCheckCard {...base} healthCheckType="HTTP" healthCheckPath="/health" />);
    fireEvent.change(screen.getByLabelText(/Response text/), { target: { value: "OK" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", expect.objectContaining({ responseText: "OK" })));
    set.mockClear();
    rerender(
      <QueryClientProvider client={qc}>
        <I18nProvider><HealthCheckCard {...base} healthCheckType="HTTP" healthCheckPath="/health" healthCheckResponseText="OK" /></I18nProvider>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText(/Response text/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", expect.objectContaining({ responseText: null })));
  });

  it("sends method/scheme as null when left at default on an HTTP check", async () => {
    const set = vi.spyOn(api, "setAppHealthCheck").mockResolvedValue({ ok: true });
    wrap(<HealthCheckCard {...base} healthCheckType="HTTP" healthCheckPath="/health" />);
    fireEvent.change(screen.getByLabelText("Interval (s)"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", expect.objectContaining({ method: null, scheme: null })));
  });

  it("gates Save until a timing changes, then PUTs the check", async () => {
    const set = vi.spyOn(api, "setAppHealthCheck").mockResolvedValue({ ok: true });
    wrap(<HealthCheckCard {...base} healthCheckType="HTTP" healthCheckPath="/health" />);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Interval (s)"), { target: { value: "15" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", expect.objectContaining({ type: "HTTP", path: "/health", interval: 15 })));
  });
});
