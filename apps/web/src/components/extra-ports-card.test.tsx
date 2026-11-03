import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { ExtraPortsCard } from "./extra-ports-card";
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
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const saveBtn = () => screen.getByRole("button", { name: "Save" });
const host = (i = 0) => screen.getAllByLabelText("Host")[i] as HTMLInputElement;
const container = (i = 0) => screen.getAllByLabelText("Container")[i] as HTMLInputElement;

describe("ExtraPortsCard", () => {
  it("shows an empty line and keeps Save disabled when there are no ports", () => {
    wrap(<ExtraPortsCard id="a1" ports={[]} />);
    expect(screen.getByText(/no extra ports/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add port" })).toBeTruthy();
    expect(saveBtn()).toHaveProperty("disabled", true); // pristine
  });

  it("blocks Save on a half-filled row instead of silently dropping it", () => {
    wrap(<ExtraPortsCard id="a1" ports={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add port" }));
    fireEvent.change(host(), { target: { value: "8080" } }); // container left blank
    expect(screen.getByRole("alert")).toHaveTextContent(/enter both/i);
    expect(saveBtn()).toHaveProperty("disabled", true);
  });

  it("rejects out-of-range and non-integer ports", () => {
    wrap(<ExtraPortsCard id="a1" ports={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add port" }));
    fireEvent.change(host(), { target: { value: "70000" } });
    fireEvent.change(container(), { target: { value: "80" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/65535/);
    expect(saveBtn()).toHaveProperty("disabled", true);
    fireEvent.change(host(), { target: { value: "12.5" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/whole number/i);
    expect(saveBtn()).toHaveProperty("disabled", true);
  });

  it("flags a duplicate host port + protocol and blocks Save", () => {
    wrap(<ExtraPortsCard id="a1" ports={[{ hostPort: 8080, containerPort: 80, protocol: "tcp" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add port" }));
    fireEvent.change(host(1), { target: { value: "8080" } });
    fireEvent.change(container(1), { target: { value: "90" } });
    // Both colliding rows are flagged.
    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((a) => /already mapped/i.test(a.textContent ?? ""))).toBe(true);
    expect(saveBtn()).toHaveProperty("disabled", true);
  });

  it("saves only the complete rows and drops a blank one without error", async () => {
    const set = vi.spyOn(api, "setAppExtraPorts").mockResolvedValue({ ok: true });
    wrap(<ExtraPortsCard id="a1" ports={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add port" }));
    fireEvent.change(host(), { target: { value: "8080" } });
    fireEvent.change(container(), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Add port" })); // a trailing blank row
    expect(screen.queryByRole("alert")).toBeNull(); // blank row is not an error
    expect(saveBtn()).toHaveProperty("disabled", false);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", [{ hostPort: 8080, containerPort: 80, protocol: "tcp" }]));
  });

  it("enables Save only once the set actually changes", () => {
    wrap(<ExtraPortsCard id="a1" ports={[{ hostPort: 8080, containerPort: 80, protocol: "tcp" }]} />);
    expect(saveBtn()).toHaveProperty("disabled", true); // loaded, unchanged
    fireEvent.change(container(), { target: { value: "81" } });
    expect(saveBtn()).toHaveProperty("disabled", false);
  });

  it("confirms before removing a row that mirrors saved config", async () => {
    wrap(<ExtraPortsCard id="a1" ports={[{ hostPort: 8080, containerPort: 80, protocol: "tcp" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    // A confirm dialog appears rather than an immediate removal.
    await screen.findByText(/stops being published/i);
    expect(host()).toBeTruthy(); // row still there until confirmed
  });
});
