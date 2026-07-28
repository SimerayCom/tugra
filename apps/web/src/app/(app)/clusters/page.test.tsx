import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import ClustersPage from "./page";
import { api } from "../../../lib/api";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("ClustersPage", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the empty state and creates a cluster", async () => {
    vi.spyOn(api, "listClusters").mockResolvedValue([]);
    const createSpy = vi.spyOn(api, "createCluster").mockResolvedValue({ id: "c1" } as never);
    wrap(<ClustersPage />);
    await waitFor(() => expect(screen.getByText(/No clusters yet/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "New cluster" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "eu-west" } });
    fireEvent.click(screen.getByRole("button", { name: "Create cluster" }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ teamId: "t1", name: "eu-west", description: undefined }));
  });

  it("lists clusters with node counts", async () => {
    vi.spyOn(api, "listClusters").mockResolvedValue([
      { id: "c1", teamId: "t1", name: "eu-west", description: "prod", nodeCount: 3, swarmStatus: "NONE", canWrite: true, createdAt: "2026-01-01" },
    ]);
    wrap(<ClustersPage />);
    expect(await screen.findByText("eu-west")).toBeTruthy();
    expect(screen.getByText("3 servers")).toBeTruthy();
  });
});
