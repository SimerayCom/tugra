import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { api } from "../lib/api";
import { DnsAutoSetup } from "./dns-auto-setup";
import type { DnsCredential } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={qc}><I18nProvider>{ui}</I18nProvider></QueryClientProvider>);

const CRED: DnsCredential = { id: "dc1", name: "cf", teamId: "t1", provider: "cloudflare", cfAccountId: null, lastVerifiedAt: null, createdAt: "", canWrite: true };

describe("DnsAutoSetup", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the connect form when the team has no credential and saves one with the right payload", async () => {
    vi.spyOn(api, "listDnsCredentials").mockResolvedValue([]);
    const createSpy = vi.spyOn(api, "createDnsCredential").mockResolvedValue({ ...CRED } as never);
    wrap(<DnsAutoSetup appId="a1" teamId="t1" domain="example.com" onApplied={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("API token")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "cf" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "TOKEN" } });
    fireEvent.click(screen.getByText("Save credential"));
    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith({ teamId: "t1", name: "cf", provider: "cloudflare", apiToken: "TOKEN", cfAccountId: undefined }),
    );
  });

  it("applies the auto-setup with the selected credential and fires onApplied", async () => {
    vi.spyOn(api, "listDnsCredentials").mockResolvedValue([CRED]);
    const applySpy = vi.spyOn(api, "autoSetupDomain").mockResolvedValue({ dryRun: false, hostname: "example.com", apex: true, status: "pending", records: [] } as never);
    const onApplied = vi.fn();
    wrap(<DnsAutoSetup appId="a1" teamId="t1" domain="example.com" onApplied={onApplied} />);
    // wait until the credential loads (the dropdown appears) so the buttons are enabled
    await waitFor(() => expect(screen.getByText("Cloudflare credential")).toBeTruthy());
    fireEvent.click(screen.getByText("Set up DNS"));
    await waitFor(() =>
      expect(applySpy).toHaveBeenCalledWith("a1", { domain: "example.com", credentialId: "dc1", includeWww: true, overwrite: false }),
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it("previews the plan into a table and reveals the overwrite toggle on a conflict", async () => {
    vi.spyOn(api, "listDnsCredentials").mockResolvedValue([CRED]);
    vi.spyOn(api, "autoSetupDomain").mockResolvedValue({
      dryRun: true,
      hostname: "example.com",
      apex: true,
      records: [{ type: "A", name: "example.com", content: "9.9.9.9", proxied: false, action: "conflict", existingId: "r1" }],
    } as never);
    wrap(<DnsAutoSetup appId="a1" teamId="t1" domain="example.com" onApplied={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Cloudflare credential")).toBeTruthy());
    fireEvent.click(screen.getByText("Preview records"));
    await waitFor(() => expect(screen.getByText("9.9.9.9")).toBeTruthy());
    expect(screen.getByText("Overwrite records that point elsewhere")).toBeTruthy();
  });

  it("shows a load error (not the connect form) when listing credentials fails", async () => {
    vi.spyOn(api, "listDnsCredentials").mockRejectedValue(new Error("creds boom"));
    wrap(<DnsAutoSetup appId="a1" teamId="t1" domain="example.com" onApplied={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("creds boom")).toBeTruthy());
    expect(screen.queryByLabelText("API token")).toBeNull(); // no misleading connect form on error
  });

  it("resets the opt-in overwrite and the stale plan when the domain changes", async () => {
    vi.spyOn(api, "listDnsCredentials").mockResolvedValue([CRED]);
    vi.spyOn(api, "autoSetupDomain").mockResolvedValue({
      dryRun: true,
      hostname: "example.com",
      records: [{ type: "A", name: "example.com", content: "9.9.9.9", proxied: false, action: "conflict", existingId: "r1" }],
    } as never);
    const { rerender } = wrap(<DnsAutoSetup appId="a1" teamId="t1" domain="example.com" onApplied={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Cloudflare credential")).toBeTruthy());
    fireEvent.click(screen.getByText("Preview records"));
    await waitFor(() => expect(screen.getByText("9.9.9.9")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Overwrite records that point elsewhere"));
    // change the domain → the stale conflict plan is cleared so it can't be applied against a new domain
    rerender(<QueryClientProvider client={qc}><I18nProvider><DnsAutoSetup appId="a1" teamId="t1" domain="other.com" onApplied={vi.fn()} /></I18nProvider></QueryClientProvider>);
    await waitFor(() => expect(screen.queryByText("9.9.9.9")).toBeNull());
  });

  it("shows the manual-fallback records on demand", async () => {
    vi.spyOn(api, "listDnsCredentials").mockResolvedValue([]);
    const manualSpy = vi.spyOn(api, "getManualDnsRecords").mockResolvedValue({
      hostname: "example.com",
      records: [{ type: "A", name: "example.com", content: "203.0.113.7" }],
    });
    wrap(<DnsAutoSetup appId="a1" teamId="t1" domain="example.com" onApplied={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Not using Cloudflare? Set up manually")).toBeTruthy());
    fireEvent.click(screen.getByText("Not using Cloudflare? Set up manually"));
    await waitFor(() => expect(manualSpy).toHaveBeenCalledWith("a1", "example.com", true));
    await waitFor(() => expect(screen.getByText("203.0.113.7")).toBeTruthy());
  });
});
