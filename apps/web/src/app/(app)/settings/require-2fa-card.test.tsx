import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { Require2faCard } from "./require-2fa-card";

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <I18nProvider>
        <Require2faCard />
      </I18nProvider>
    </QueryClientProvider>,
  );

const settings = (require2fa: boolean) => ({ apiEnabled: true, apiAllowedIps: [], publicUrl: null, acmeEmail: null, require2fa });

describe("Require2faCard", () => {
  beforeEach(() => {
    h.user = { isInstanceOwner: true, twoFaEnabled: true };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches", () => {
    h.user = { isInstanceOwner: false };
    const get = vi.spyOn(api, "getInstanceSettings");
    wrap();
    expect(screen.queryByText("Require 2FA for owners and admins")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("turns the policy on for an owner who has 2FA", async () => {
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue(settings(false));
    const upd = vi.spyOn(api, "updateInstanceSettings").mockResolvedValue(settings(true));
    wrap();
    const box = (await screen.findByLabelText("Require two-factor authentication")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(upd).toHaveBeenCalledWith({ require2fa: true }));
  });

  it("is blocked, with the reason, while the owner has no 2FA of their own", async () => {
    h.user = { isInstanceOwner: true, twoFaEnabled: false };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue(settings(false));
    wrap();
    const box = (await screen.findByLabelText("Require two-factor authentication")) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText("Turn on 2FA for your own account first.")).toBeTruthy();
  });

  it("can always be switched off", async () => {
    h.user = { isInstanceOwner: true, twoFaEnabled: false };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue(settings(true));
    const upd = vi.spyOn(api, "updateInstanceSettings").mockResolvedValue(settings(false));
    wrap();
    const box = (await screen.findByLabelText("Require two-factor authentication")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(upd).toHaveBeenCalledWith({ require2fa: false }));
  });
});
