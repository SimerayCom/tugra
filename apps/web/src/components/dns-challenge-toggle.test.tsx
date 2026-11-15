import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { DnsChallengeToggle } from "./dns-challenge-toggle";
import { api } from "../lib/api";

afterEach(cleanup);

function mount(dnsChallenge = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <DnsChallengeToggle appId="a1" serverId="s1" dnsChallenge={dnsChallenge} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("DnsChallengeToggle", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("is disabled with an explanation when the server has no DNS-01 credentials", async () => {
    vi.spyOn(api, "getServer").mockResolvedValue({ id: "s1", hasDnsCreds: false, dnsCredentialId: null } as never);
    mount();
    await screen.findByText(/no DNS-01 credentials/);
    expect(screen.getByRole("checkbox", { name: /Issue the certificate with DNS-01/ })).toBeDisabled();
  });

  it("sends only dnsChallenge when toggled on", async () => {
    vi.spyOn(api, "getServer").mockResolvedValue({ id: "s1", hasDnsCreds: true, dnsCredentialId: null } as never);
    const set = vi.spyOn(api, "setAppDomainOptions").mockResolvedValue({ ok: true });
    mount();
    const box = await screen.findByRole("checkbox", { name: /Issue the certificate with DNS-01/ });
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.click(box);
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { dnsChallenge: true }));
    await waitFor(() => expect(box).toBeChecked());
  });

  it("surfaces the hub's 400 message and leaves the switch off", async () => {
    vi.spyOn(api, "getServer").mockResolvedValue({ id: "s1", hasDnsCreds: true } as never);
    vi.spyOn(api, "setAppDomainOptions").mockRejectedValue(new Error("DNS-01 needs a wildcard-capable credential"));
    mount();
    const box = await screen.findByRole("checkbox", { name: /Issue the certificate with DNS-01/ });
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.click(box);
    await screen.findByText("DNS-01 needs a wildcard-capable credential");
    expect(box).not.toBeChecked();
  });

  it("can always be switched off, even when the server has lost its credentials", async () => {
    vi.spyOn(api, "getServer").mockResolvedValue({ id: "s1", hasDnsCreds: false } as never);
    const set = vi.spyOn(api, "setAppDomainOptions").mockResolvedValue({ ok: true });
    mount(true);
    const box = await screen.findByRole("checkbox", { name: /Issue the certificate with DNS-01/ });
    expect(box).toBeEnabled();
    fireEvent.click(box);
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { dnsChallenge: false }));
  });
});
