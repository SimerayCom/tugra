import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";

const confirmFn = vi.hoisted(() => vi.fn());
vi.mock("../../../components/confirm", () => ({ useConfirm: () => confirmFn }));

import { OAuthClientsCard } from "./oauth-clients-card";

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <OAuthClientsCard />
      </I18nProvider>
    </QueryClientProvider>,
  );

const grant = { id: "g1", clientName: "Claude Code", teamId: "t1", teamName: "Acme", scopes: ["read", "deploy"], createdAt: "2026-12-01T00:00:00Z", lastUsedAt: null };

describe("OAuthClientsCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    confirmFn.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows an empty state when nothing is connected", async () => {
    vi.spyOn(api, "listOAuthGrants").mockResolvedValue([]);
    wrap();
    expect(await screen.findByText("No connected clients")).toBeTruthy();
  });

  it("lists a client with its team and scopes", async () => {
    vi.spyOn(api, "listOAuthGrants").mockResolvedValue([grant]);
    wrap();
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("revokes after confirmation", async () => {
    vi.spyOn(api, "listOAuthGrants").mockResolvedValue([grant]);
    const revoke = vi.spyOn(api, "revokeOAuthGrant").mockResolvedValue({ ok: true });
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Claude Code?" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("g1"));
    expect(confirmFn).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  });

  it("does nothing when the confirmation is declined", async () => {
    confirmFn.mockResolvedValue(false);
    vi.spyOn(api, "listOAuthGrants").mockResolvedValue([grant]);
    const revoke = vi.spyOn(api, "revokeOAuthGrant").mockResolvedValue({ ok: true });
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Claude Code?" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(revoke).not.toHaveBeenCalled();
  });
});
