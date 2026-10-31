import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ConfirmProvider } from "../../../components/confirm";
import SecretProvidersPage from "./page";
import { api } from "../../../lib/api";
import type { SecretProvider } from "../../../lib/types";

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

const provider = (over: Partial<SecretProvider> = {}): SecretProvider => ({
  id: "p1", name: "prod-vault", teamId: "t1", kind: "vault", address: "https://vault.x", lastVerifiedAt: null, refCount: 0, createdAt: "", canWrite: true, ...over,
});

describe("SecretProvidersPage", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("Pro: shows the empty state and creates a provider, then clears the token input", async () => {
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: "pro" } as never);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([]);
    const create = vi.spyOn(api, "createSecretProvider").mockResolvedValue(provider());
    wrap(<SecretProvidersPage />);
    await waitFor(() => expect(screen.getByText(/No secret stores yet/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "prod-vault" } });
    fireEvent.change(screen.getByLabelText("Store address"), { target: { value: "https://vault.x" } });
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "hvs.supersecret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect store" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ teamId: "t1", name: "prod-vault", kind: "vault", address: "https://vault.x", token: "hvs.supersecret" }));
    // token cleared after success
    await waitFor(() => expect(screen.queryByDisplayValue("hvs.supersecret")).toBeNull());
  });

  it("never renders a token, even if the API object carries one", async () => {
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: "pro" } as never);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([{ ...provider(), tokenEnc: "LEAKED_TOKEN", token: "LEAKED_TOKEN" } as never]);
    wrap(<SecretProvidersPage />);
    await waitFor(() => expect(screen.getByText("prod-vault")).toBeTruthy());
    expect(document.body.innerHTML).not.toContain("LEAKED_TOKEN");
  });

  it("Test button verifies the connection and shows the result", async () => {
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: "pro" } as never);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider()]);
    const test = vi.spyOn(api, "testSecretProvider").mockResolvedValue({ ok: true });
    wrap(<SecretProvidersPage />);
    await waitFor(() => expect(screen.getByText("prod-vault")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(test).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("Connection verified")).toBeTruthy();
  });

  it("Community: Pro badge + upsell, create form disabled, delete still enabled at refCount 0", async () => {
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: "community" } as never);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider({ refCount: 0 })]);
    wrap(<SecretProvidersPage />);
    await waitFor(() => expect(screen.getByText("prod-vault")).toBeTruthy());
    expect(screen.getAllByText(/Pro feature|Pro$/i).length).toBeGreaterThan(0);
    expect((screen.getByLabelText("Access token") as HTMLInputElement).disabled).toBe(true);
    // delete stays available on Community so a downgraded instance can remove unused stores
    expect((screen.getByLabelText("Delete") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Delete is disabled while the store is in use (refCount > 0)", async () => {
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: "pro" } as never);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider({ refCount: 2 })]);
    wrap(<SecretProvidersPage />);
    await waitFor(() => expect(screen.getByText("prod-vault")).toBeTruthy());
    expect((screen.getByLabelText(/Remove the app secrets/i) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Edit: changing the address with a blank token is blocked; a name-only edit sends no token", async () => {
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: "pro" } as never);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider()]);
    const update = vi.spyOn(api, "updateSecretProvider").mockResolvedValue(provider());
    wrap(<SecretProvidersPage />);
    await waitFor(() => expect(screen.getByText("prod-vault")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Edit"));
    // change the address but leave the token blank → blocked
    const addr = screen.getAllByDisplayValue("https://vault.x")[0];
    fireEvent.change(addr, { target: { value: "https://evil.x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Enter the access token again/i)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();

    // reset the address to original and change only the name → no token key sent
    fireEvent.change(screen.getAllByDisplayValue("https://evil.x")[0], { target: { value: "https://vault.x" } });
    fireEvent.change(screen.getAllByDisplayValue("prod-vault")[0], { target: { value: "prod-vault-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const callArgs = update.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty("token");
    expect(callArgs).toMatchObject({ name: "prod-vault-2", address: "https://vault.x" });
  });

  it("a row the caller cannot write shows no action buttons", async () => {
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: "pro" } as never);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider({ canWrite: false })]);
    wrap(<SecretProvidersPage />);
    await waitFor(() => expect(screen.getByText("prod-vault")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
    expect(screen.queryByLabelText("Edit")).toBeNull();
    expect(screen.queryByLabelText("Delete")).toBeNull();
  });
});
