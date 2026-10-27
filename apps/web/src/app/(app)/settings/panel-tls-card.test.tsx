import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ToastProvider } from "../../../components/toast";
import { api } from "../../../lib/api";
import type { PanelTlsStatus, PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { PanelTlsCard } from "./panel-tls-card";

const ENABLED: PanelTlsStatus = {
  enabled: true,
  domain: "demo.tugra.io",
  resolver: "le",
  originHost: "demo.tugra.io",
  originMatches: true,
  acmeEmailOk: true,
  localServerId: "s-local",
  localServerOnline: true,
  proxyRunning: true,
  routerPresent: true,
};

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <PanelTlsCard />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("PanelTlsCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "getPanelTls").mockResolvedValue({ ...ENABLED });
    vi.spyOn(api, "applyPanelTls").mockResolvedValue({ ...ENABLED });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches", () => {
    wrap();
    expect(screen.queryByText("Panel HTTPS")).toBeNull();
    expect(api.getPanelTls).not.toHaveBeenCalled();
  });

  it("owner + enabled: shows the domain + a Re-apply button", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    expect(await screen.findByText("Panel HTTPS")).toBeTruthy();
    expect(await screen.findByText("demo.tugra.io")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-apply" })).toBeTruthy();
  });

  it("owner: Re-apply calls applyPanelTls", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("demo.tugra.io");
    fireEvent.click(screen.getByRole("button", { name: "Re-apply" }));
    await waitFor(() => expect(api.applyPanelTls).toHaveBeenCalled());
  });

  it("owner + not configured: shows the install hint, no Re-apply", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getPanelTls").mockResolvedValue({ ...ENABLED, enabled: false, domain: null });
    wrap();
    await screen.findByText("Panel HTTPS");
    await waitFor(() => expect(screen.getByText(/Not configured/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Re-apply" })).toBeNull();
  });

  it("owner + local server offline: Re-apply is disabled", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getPanelTls").mockResolvedValue({ ...ENABLED, localServerOnline: false });
    wrap();
    await screen.findByText("demo.tugra.io");
    await waitFor(() => expect(screen.getByRole("button", { name: "Re-apply" })).toBeDisabled());
  });
});
