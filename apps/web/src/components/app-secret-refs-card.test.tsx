import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { AppSecretRefsCard } from "./app-secret-refs-card";
import { api } from "../lib/api";
import type { SecretProvider, SecretRefView } from "../lib/types";

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

const provider = (over: Partial<SecretProvider> = {}): SecretProvider => ({
  id: "p1", name: "prod-vault", teamId: "t1", kind: "vault", address: "https://vault.x", lastVerifiedAt: null, refCount: 0, createdAt: "", canWrite: true, ...over,
});
const ref = (over: Partial<SecretRefView> = {}): SecretRefView => ({
  refId: "r1", envVar: "DB_PASSWORD", providerId: "p1", providerName: "prod-vault", kind: "vault", remoteKey: "secret/app#DB_PASSWORD", overridesAppEnv: false, createdAt: "", ...over,
});
const edition = (e: string) => vi.spyOn(api, "getInstanceStatus").mockResolvedValue({ edition: e } as never);

describe("AppSecretRefsCard", () => {
  it("lists a ref showing envVar, provider and locator — never a value", async () => {
    edition("pro");
    vi.spyOn(api, "getAppSecretRefs").mockResolvedValue([ref({ overridesAppEnv: true })]);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider()]);
    wrap(<AppSecretRefsCard id="a1" teamId="t1" canWrite />);
    expect(await screen.findByText("DB_PASSWORD")).toBeTruthy();
    expect(screen.getByText("prod-vault")).toBeTruthy();
    expect(screen.getByText("secret/app#DB_PASSWORD")).toBeTruthy();
    expect(screen.getByText(/replaces the app env var/i)).toBeTruthy(); // overridesAppEnv note
  });

  it("Pro: filters provider options to same team AND canWrite, and binds with the typed values", async () => {
    edition("pro");
    vi.spyOn(api, "getAppSecretRefs").mockResolvedValue([]);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([
      provider({ id: "p1", name: "prod-vault", teamId: "t1", canWrite: true }),
      provider({ id: "p2", name: "other-team", teamId: "t2", canWrite: true }),
      provider({ id: "p3", name: "readonly", teamId: "t1", canWrite: false }),
    ]);
    const bind = vi.spyOn(api, "bindAppSecret").mockResolvedValue(ref());
    wrap(<AppSecretRefsCard id="a1" teamId="t1" canWrite />);
    await screen.findByText(/no external secrets/i);
    // only the same-team, writable provider is offered
    await waitFor(() => expect(screen.getByRole("option", { name: /prod-vault/ })).toBeTruthy());
    expect(screen.queryByRole("option", { name: /other-team/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /readonly/ })).toBeNull();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("Environment variable"), { target: { value: "DB_PASSWORD" } });
    fireEvent.change(screen.getByLabelText("Location in the store"), { target: { value: "secret/app#DB_PASSWORD" } });
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    await waitFor(() => expect(bind).toHaveBeenCalledWith("a1", { providerId: "p1", envVar: "DB_PASSWORD", remoteKey: "secret/app#DB_PASSWORD" }));
  });

  it("Community: shows the upsell, disables the form and never binds, but Unbind still works", async () => {
    edition("community");
    vi.spyOn(api, "getAppSecretRefs").mockResolvedValue([ref()]);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider()]);
    const bind = vi.spyOn(api, "bindAppSecret").mockResolvedValue(ref());
    const unbind = vi.spyOn(api, "unbindAppSecret").mockResolvedValue({ ok: true });
    wrap(<AppSecretRefsCard id="a1" teamId="t1" canWrite />);
    expect(await screen.findByText(/External secrets are a Pro feature/i)).toBeTruthy();
    const envInput = screen.getByLabelText("Environment variable") as HTMLInputElement;
    expect(envInput.disabled).toBe(true);
    // the existing ref's Remove button still works on Community (downgrade-safe)
    fireEvent.click(screen.getByLabelText("Remove"));
    await waitFor(() => expect(unbind).toHaveBeenCalledWith("a1", "r1"));
    expect(bind).not.toHaveBeenCalled();
  });

  it("edition still loading: controls disabled, no upsell flash", async () => {
    vi.spyOn(api, "getInstanceStatus").mockReturnValue(new Promise(() => {}) as never);
    vi.spyOn(api, "getAppSecretRefs").mockResolvedValue([]);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider()]);
    wrap(<AppSecretRefsCard id="a1" teamId="t1" canWrite />);
    await screen.findByText(/no external secrets/i);
    expect(screen.queryByText(/Pro feature/i)).toBeNull();
    expect((screen.getByLabelText("Environment variable") as HTMLInputElement).disabled).toBe(true);
  });

  it("canWrite=false: list only, no form, no providers query", async () => {
    edition("pro");
    vi.spyOn(api, "getAppSecretRefs").mockResolvedValue([ref()]);
    const list = vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider()]);
    wrap(<AppSecretRefsCard id="a1" teamId="t1" canWrite={false} />);
    expect(await screen.findByText("DB_PASSWORD")).toBeTruthy();
    expect(screen.queryByLabelText("Environment variable")).toBeNull();
    expect(screen.queryByLabelText("Remove")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("validates env var and locator client-side (Add stays disabled)", async () => {
    edition("pro");
    vi.spyOn(api, "getAppSecretRefs").mockResolvedValue([]);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider()]);
    wrap(<AppSecretRefsCard id="a1" teamId="t1" canWrite />);
    await screen.findByText(/no external secrets/i);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("Environment variable"), { target: { value: "1BAD" } });
    fireEvent.change(screen.getByLabelText("Location in the store"), { target: { value: "no-hash" } });
    expect(screen.getByText(/POSIX name/i)).toBeTruthy();
    expect(screen.getByText(/Expected <mount>/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add secret" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Pro with no eligible provider: links to the secret-stores page", async () => {
    edition("pro");
    vi.spyOn(api, "getAppSecretRefs").mockResolvedValue([]);
    vi.spyOn(api, "listSecretProviders").mockResolvedValue([provider({ teamId: "other" })]);
    wrap(<AppSecretRefsCard id="a1" teamId="t1" canWrite />);
    expect(await screen.findByText(/No secret store is connected/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Manage secret stores/i }).getAttribute("href")).toBe("/secret-providers");
  });
});
