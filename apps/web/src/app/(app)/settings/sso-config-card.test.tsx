import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { SsoConfigCard } from "./sso-config-card";

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <SsoConfigCard />
      </I18nProvider>
    </QueryClientProvider>,
  );

const proSettings = { apiEnabled: true, apiAllowedIps: [], publicUrl: null, acmeEmail: null, edition: "pro" };
const oidcOff = { oidcEnabled: false, oidcIssuer: null, oidcClientId: null, oidcAllowedDomains: [], clientSecretSet: false };

describe("SsoConfigCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue(proSettings);
    vi.spyOn(api, "getOidcConfig").mockResolvedValue(oidcOff);
    vi.spyOn(api, "updateOidcConfig").mockResolvedValue({ ...oidcOff, oidcEnabled: true, oidcIssuer: "https://idp.example.com", oidcClientId: "cid", clientSecretSet: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches config", () => {
    wrap();
    expect(screen.queryByText("Single sign-on (SSO)")).toBeNull();
    expect(api.getOidcConfig).not.toHaveBeenCalled();
  });

  it("renders nothing on a Community edition and does NOT fetch the OIDC config (avoids a 403)", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ ...proSettings, edition: "community" });
    wrap();
    // getInstanceSettings resolves (edition gate), but the card stays hidden and never calls getOidcConfig.
    await waitFor(() => expect(api.getInstanceSettings).toHaveBeenCalled());
    expect(screen.queryByText("Single sign-on (SSO)")).toBeNull();
    expect(api.getOidcConfig).not.toHaveBeenCalled();
  });

  it("shows the panel for a Pro owner and seeds it from the server", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getOidcConfig").mockResolvedValue({ oidcEnabled: true, oidcIssuer: "https://idp.example.com", oidcClientId: "cid", oidcAllowedDomains: ["corp.io"], clientSecretSet: true });
    wrap();
    expect(await screen.findByText("Single sign-on (SSO)")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Issuer URL") as HTMLInputElement).value).toBe("https://idp.example.com"));
    expect((screen.getByLabelText("Allowed email domains") as HTMLTextAreaElement).value).toBe("corp.io");
    // The secret input is empty but shows a "set" placeholder (write-only).
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).placeholder).toMatch(/set/);
  });

  it("saves the config, sending the secret only when a new one is typed", async () => {
    h.user = { isInstanceOwner: true };
    // Seed with a known issuer so we can wait for the effect to apply before editing (avoids the seed
    // clobbering our typed values when getOidcConfig resolves).
    vi.spyOn(api, "getOidcConfig").mockResolvedValue({ oidcEnabled: false, oidcIssuer: "https://seed.example.com", oidcClientId: "seed", oidcAllowedDomains: [], clientSecretSet: false });
    wrap();
    const issuer = (await screen.findByLabelText("Issuer URL")) as HTMLInputElement;
    await waitFor(() => expect(issuer.value).toBe("https://seed.example.com"));
    fireEvent.change(issuer, { target: { value: "https://idp.example.com" } });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "cid" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "topsecret" } });
    fireEvent.change(screen.getByLabelText("Allowed email domains"), { target: { value: "corp.io\n\n  \nsub.corp.io" } });
    fireEvent.click(screen.getByRole("checkbox")); // enable SSO
    fireEvent.click(screen.getByRole("button", { name: "Save SSO settings" }));
    await waitFor(() =>
      expect(api.updateOidcConfig).toHaveBeenCalledWith({
        oidcEnabled: true,
        oidcIssuer: "https://idp.example.com",
        oidcClientId: "cid",
        oidcClientSecret: "topsecret",
        oidcAllowedDomains: ["corp.io", "sub.corp.io"],
      }),
    );
  });

  it("omits the secret field when left blank (preserves the stored one)", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getOidcConfig").mockResolvedValue({ oidcEnabled: true, oidcIssuer: "https://idp.example.com", oidcClientId: "cid", oidcAllowedDomains: ["corp.io"], clientSecretSet: true });
    wrap();
    const issuer = (await screen.findByLabelText("Issuer URL")) as HTMLInputElement;
    await waitFor(() => expect(issuer.value).toBe("https://idp.example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Save SSO settings" }));
    await waitFor(() => expect(api.updateOidcConfig).toHaveBeenCalled());
    const arg = (api.updateOidcConfig as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("oidcClientSecret");
    expect(arg.oidcEnabled).toBe(true);
  });
});
