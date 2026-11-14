import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ToastProvider } from "../../../../components/toast";
import { api } from "../../../../lib/api";
import { NetworkingCard } from "./app-detail-domain-cards";

afterEach(cleanup);
let qc: QueryClient;
const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>{ui}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => vi.restoreAllMocks());

describe("NetworkingCard", () => {
  const host = { host: "tugra_a1", port: 3000, networks: ["tugra-apps", "backend"], aliases: ["api"] };

  it("shows the internal address, its networks and aliases", () => {
    wrap(<NetworkingCard id="a1" internalHost={host} containerAlias="api" networks={["backend"]} />);
    expect(screen.getByText("tugra_a1:3000")).toBeTruthy();
    expect(screen.getByText(/Reachable from containers on: tugra-apps, backend/)).toBeTruthy();
    expect(screen.getByText(/Also resolves as: api/)).toBeTruthy();
  });

  it("explains when the address is unknown (custom --network)", () => {
    wrap(<NetworkingCard id="a1" internalHost={null} containerAlias={null} networks={[]} />);
    expect(screen.getByText(/manages its own networking/)).toBeTruthy();
  });

  it("Save is disabled until something changes, then sends a normalized, de-duplicated list and the alias", async () => {
    const set = vi.spyOn(api, "setAppNetworks").mockResolvedValue({ ok: true });
    wrap(<NetworkingCard id="a1" internalHost={host} containerAlias={null} networks={[]} />);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Extra networks"), { target: { value: "Backend\nbackend\n tugra-apps " } });
    fireEvent.change(screen.getByLabelText("Stable name"), { target: { value: "  API " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { networks: ["backend", "tugra-apps"], containerAlias: "api" }));
  });

  it("a blank stable name clears it (null)", async () => {
    const set = vi.spyOn(api, "setAppNetworks").mockResolvedValue({ ok: true });
    wrap(<NetworkingCard id="a1" internalHost={host} containerAlias="api" networks={["backend"]} />);
    fireEvent.change(screen.getByLabelText("Stable name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { networks: ["backend"], containerAlias: null }));
  });

  it("is locked (inputs and Save disabled, explanation shown) when a raw --network owns networking", () => {
    wrap(<NetworkingCard id="a1" internalHost={null} containerAlias="api" networks={["backend"]} locked />);
    expect(screen.getByText(/Networking is managed by the --network flag in Docker options/)).toBeTruthy();
    expect(screen.getByLabelText("Stable name")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Extra networks")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("is not locked by default", () => {
    wrap(<NetworkingCard id="a1" internalHost={host} containerAlias={null} networks={[]} />);
    expect(screen.queryByText(/Networking is managed by the --network flag/)).toBeNull();
    expect(screen.getByLabelText("Stable name")).toHaveProperty("disabled", false);
  });
});
