import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { RemoteAccessCard } from "./remote-access-card";
import { api } from "../lib/api";
import type { TunnelView } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const tunnel = (over: Partial<TunnelView>): TunnelView =>
  ({ configured: false, provider: null, zoneName: null, wildcardDomain: null, tunnelId: null, status: null, lastError: null, createdAt: null, updatedAt: null, ...over });

describe("RemoteAccessCard", () => {
  it("shows the setup form when no tunnel is configured and sends trimmed fields on enable", async () => {
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue(tunnel({ configured: false }));
    const setup = vi.spyOn(api, "setupTunnel").mockResolvedValue(tunnel({ configured: true }));
    wrap(<RemoteAccessCard serverId="srv1" />);
    const token = await screen.findByLabelText("Cloudflare API token");
    fireEvent.change(token, { target: { value: " tok-123 " } });
    fireEvent.change(screen.getByLabelText("Cloudflare account ID"), { target: { value: "acct-1" } });
    fireEvent.change(screen.getByLabelText("Your domain (zone)"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable remote access" }));
    await waitFor(() => expect(setup).toHaveBeenCalledWith("srv1", { apiToken: "tok-123", cfAccountId: "acct-1", zoneName: "example.com" }));
  });

  it("shows the active state (zone + Turn off) when a tunnel is configured, with no setup form", async () => {
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue(tunnel({ configured: true, zoneName: "example.com" }));
    wrap(<RemoteAccessCard serverId="srv1" />);
    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(screen.queryByLabelText("Cloudflare API token")).toBeNull();
  });
});
