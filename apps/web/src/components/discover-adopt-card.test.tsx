import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { DiscoverAdoptCard } from "./discover-adopt-card";
import { api } from "../lib/api";
import type { DiscoveredContainer } from "../lib/types";

afterEach(cleanup);

function dc(over: Partial<DiscoveredContainer> = {}): DiscoveredContainer {
  return {
    id: "cid",
    name: "legacy-web",
    image: "nginx:1.25",
    state: "running",
    ports: [{ host: 8080, container: 80, protocol: "tcp" }],
    env: [{ key: "APP_ENV", value: "prod" }],
    mounts: [],
    restartPolicy: "no",
    isTugra: false,
    composeProject: null,
    adoptable: true,
    ...over,
  };
}

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("DiscoverAdoptCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("scans and lists foreign containers; compose ones are not adoptable", async () => {
    vi.spyOn(api, "discoverContainers").mockResolvedValue({
      containers: [dc(), dc({ id: "c2", name: "stack-db-1", image: "postgres:16", composeProject: "stack", adoptable: false })],
    });
    wrap(<DiscoverAdoptCard id="s1" />);
    fireEvent.click(screen.getByText("Scan"));
    await waitFor(() => expect(screen.getByText("legacy-web")).toBeTruthy());
    expect(screen.getByText("stack-db-1")).toBeTruthy();
    // adoptable row → an Adopt button; compose row → a "not yet" badge instead
    expect(screen.getByText(/compose/)).toBeTruthy();
    expect(screen.getAllByText("Adopt").length).toBe(1);
  });

  it("shows an empty state when nothing unmanaged is found", async () => {
    vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: [] });
    wrap(<DiscoverAdoptCard id="s1" />);
    fireEvent.click(screen.getByText("Scan"));
    await waitFor(() => expect(screen.getByText(/No unmanaged containers/)).toBeTruthy());
  });

  it("opens a prefilled adopt modal with the data warning and submits the adoption", async () => {
    vi.spyOn(api, "discoverContainers").mockResolvedValue({ containers: [dc()] });
    const adoptSpy = vi.spyOn(api, "adoptContainer").mockResolvedValue({ id: "app1" } as never);
    wrap(<DiscoverAdoptCard id="s1" />);
    fireEvent.click(screen.getByText("Scan"));
    await waitFor(() => expect(screen.getByText("Adopt")).toBeTruthy());

    fireEvent.click(screen.getByText("Adopt")); // row → open modal
    const dialog = await screen.findByRole("dialog");
    // prefilled name
    expect((within(dialog).getByDisplayValue("legacy-web") as HTMLInputElement).value).toBe("legacy-web");
    // the loud "data not migrated" warning is present
    expect(within(dialog).getByText(/redeploy from Tugra recreates it/)).toBeTruthy();

    // submit (the modal's Adopt button)
    fireEvent.click(within(dialog).getByText("Adopt"));
    await waitFor(() =>
      expect(adoptSpy).toHaveBeenCalledWith("s1", { container: "legacy-web", name: "legacy-web", portIndex: 0, envKeys: ["APP_ENV"] }),
    );
  });
});
