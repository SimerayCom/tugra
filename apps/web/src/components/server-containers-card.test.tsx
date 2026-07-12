import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ServerContainersCard } from "./server-containers-card";
import { api } from "../lib/api";
import type { ContainerInventoryRow, ServerContainers } from "../lib/types";

afterEach(cleanup);

function row(over: Partial<ContainerInventoryRow> = {}): ContainerInventoryRow {
  return { name: "c", containerId: "id", ts: 1, cpu: 3, memUsed: 1, memTotal: 2, memPct: 50, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0, ...over };
}

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("ServerContainersCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists every container with its stats", async () => {
    const data: ServerContainers = {
      containers: [row({ name: "tugra_app1", cpu: 12.5 }), row({ name: "postgres", memPct: 90 })],
    };
    const spy = vi.spyOn(api, "getServerContainers").mockResolvedValue(data);
    wrap(<ServerContainersCard id="s1" />);
    await waitFor(() => expect(screen.getByText("tugra_app1")).toBeTruthy());
    expect(screen.getByText("postgres")).toBeTruthy();
    expect(screen.getByText("12.5%")).toBeTruthy(); // cpu badge
    expect(spy).toHaveBeenCalledWith("s1");
  });

  it("shows an empty state when no containers are running", async () => {
    vi.spyOn(api, "getServerContainers").mockResolvedValue({ containers: [] });
    wrap(<ServerContainersCard id="s1" />);
    await waitFor(() => expect(screen.getByText(/No containers running/)).toBeTruthy());
  });

  it("degrades to the empty state (not a crash) when the initial load errors with no data", async () => {
    vi.spyOn(api, "getServerContainers").mockRejectedValue(new Error("boom"));
    wrap(<ServerContainersCard id="s1" />);
    await waitFor(() => expect(screen.getByText(/No containers running/)).toBeTruthy());
  });
});
