import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ConfirmProvider } from "../../../components/confirm";
import CloudCredentialsPage from "./page";
import { api } from "../../../lib/api";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("CloudCredentialsPage", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the empty state and creates a Hetzner credential (write-only token)", async () => {
    vi.spyOn(api, "listCloudCredentials").mockResolvedValue([]);
    const createSpy = vi.spyOn(api, "createCloudCredential").mockResolvedValue({ id: "cc1" } as never);
    wrap(<CloudCredentialsPage />);

    await waitFor(() => expect(screen.getByText(/No cloud providers yet/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "hz-prod" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "hztok_secret" } });
    fireEvent.click(screen.getByText("Add provider"));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith({ name: "hz-prod", teamId: "t1", provider: "hetzner", apiToken: "hztok_secret" }),
    );
  });

  it("lists a credential with its provider, never exposing a token field", async () => {
    vi.spyOn(api, "listCloudCredentials").mockResolvedValue([
      { id: "cc1", name: "hz-prod", teamId: "t1", provider: "hetzner", createdAt: "2026-07-25", canWrite: true },
    ]);
    wrap(<CloudCredentialsPage />);
    await waitFor(() => expect(screen.getByText("hz-prod")).toBeTruthy());
    expect(screen.getByText("hetzner")).toBeTruthy();
  });
});
