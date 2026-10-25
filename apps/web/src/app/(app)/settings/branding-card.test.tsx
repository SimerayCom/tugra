import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { ToastProvider } from "../../../components/toast";
import { api } from "../../../lib/api";
import type { Branding, InstanceStatus, PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { BrandingCard } from "./branding-card";

const BRANDING: Branding = { name: null, logoUrl: null, faviconUrl: null, accentColor: null, hidePoweredBy: false };
const status = (edition: string): InstanceStatus => ({ initialized: true, allowRegistration: false, edition, ssoEnabled: false });

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <BrandingCard />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("BrandingCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "getBranding").mockResolvedValue({ ...BRANDING });
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue(status("pro"));
    vi.spyOn(api, "updateBranding").mockResolvedValue({ ...BRANDING, name: "Acme" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches", () => {
    wrap();
    expect(screen.queryByText("White-label branding")).toBeNull();
    expect(api.getBranding).not.toHaveBeenCalled();
  });

  it("owner on Pro: form enabled + Save present", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    expect(await screen.findByText("White-label branding")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Product name")).not.toBeDisabled());
    expect(screen.getByRole("button", { name: "Save branding" })).toBeTruthy();
    expect(screen.queryByText("Pro")).toBeNull(); // no upsell badge on Pro
  });

  it("owner on Pro: saving sends the fields to updateBranding", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("White-label branding");
    const name = await screen.findByLabelText("Product name");
    fireEvent.change(name, { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Save branding" }));
    await waitFor(() => expect(api.updateBranding).toHaveBeenCalledWith(expect.objectContaining({ name: "Acme" })));
  });

  it("owner on Community: shows the Pro badge + upsell and disables the form", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getInstanceStatus").mockResolvedValue(status("community"));
    wrap();
    await screen.findByText("White-label branding");
    await waitFor(() => expect(screen.getByText(/White-label is a Pro feature/)).toBeTruthy());
    expect(screen.getByLabelText("Product name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save branding" })).toBeNull();
  });

  it("blocks save on an invalid accent hex", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await screen.findByText("White-label branding");
    const accent = await screen.findByLabelText("Accent color");
    fireEvent.change(accent, { target: { value: "red" } }); // not #rrggbb
    await waitFor(() => expect(screen.getByRole("button", { name: "Save branding" })).toBeDisabled());
  });
});
