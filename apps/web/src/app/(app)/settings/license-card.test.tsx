import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { LicenseCard } from "./license-card";

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <LicenseCard />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("LicenseCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "getLicense").mockResolvedValue({ plan: "community", valid: false, expiresAt: null, source: null });
    vi.spyOn(api, "activateLicense").mockResolvedValue({ plan: "pro", valid: true, expiresAt: "2027-01-01T00:00:00.000Z", source: "db" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches the license", () => {
    wrap();
    expect(screen.queryByText("Plan & license")).toBeNull();
    expect(api.getLicense).not.toHaveBeenCalled();
  });

  it("shows the current plan (and expiry) for the owner", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getLicense").mockResolvedValue({ plan: "pro", valid: true, expiresAt: "2027-01-01T00:00:00.000Z", source: "db" });
    wrap();
    expect(await screen.findByText("Plan & license")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Pro")).toBeTruthy());
  });

  it("activates a pasted token", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    const ta = (await screen.findByLabelText("License token")) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "  signed.jwt.token  " } });
    fireEvent.click(screen.getByRole("button", { name: "Activate license" }));
    await waitFor(() => expect(api.activateLicense).toHaveBeenCalledWith("signed.jwt.token")); // trimmed
  });

  it("lets the owner clear an expired/invalid stored license via Remove", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getLicense").mockResolvedValue({ plan: "community", valid: false, expiresAt: null, source: "db" });
    wrap();
    const remove = await screen.findByRole("button", { name: "Remove" });
    fireEvent.click(remove);
    await waitFor(() => expect(api.activateLicense).toHaveBeenCalledWith(""));
  });

  it("surfaces an activation error", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "activateLicense").mockRejectedValue(new Error("invalid or expired license"));
    wrap();
    const ta = (await screen.findByLabelText("License token")) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "forged" } });
    fireEvent.click(screen.getByRole("button", { name: "Activate license" }));
    expect(await screen.findByText("invalid or expired license")).toBeTruthy();
  });
});
