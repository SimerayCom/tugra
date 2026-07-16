import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { PublicUser } from "../../../lib/types";

// Owner flag is mutable per test; useAuth/confirm/navigation are replaced so the card renders standalone.
const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../../../components/confirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ApiTokensCard } from "./api-tokens-card";

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ApiTokensCard />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("ApiTokensCard scope selector", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "listApiTokens").mockResolvedValue([]);
    vi.spyOn(api, "createApiToken").mockResolvedValue({
      token: "tugra_pat_new",
      view: { id: "t1", name: "x", prefix: "tugra_pat_", scopes: ["read"], expiresAt: null, lastUsedAt: null, createdAt: "" },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("hides owner-only scopes (admin, read:secrets) for a non-owner", () => {
    wrap();
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Write")).toBeTruthy();
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.queryByText("Read secrets")).toBeNull();
    // exactly three checkboxes (read/write/deploy) are offered
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("shows all five scopes for the instance owner", () => {
    h.user = { isInstanceOwner: true };
    wrap();
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.getByText("Read secrets")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
  });

  it("keeps the read scope locked (checked + disabled)", () => {
    wrap();
    const read = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    expect(read.checked).toBe(true);
    expect(read.disabled).toBe(true);
  });

  it("submits the ticked scopes (read baseline + deploy) to createApiToken", async () => {
    wrap();
    const boxes = screen.getAllByRole("checkbox"); // [read, write, deploy]
    fireEvent.click(boxes[2]); // tick deploy
    fireEvent.change(screen.getByPlaceholderText(/Token name/), { target: { value: "ci-deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createApiToken).toHaveBeenCalledWith("ci-deploy", ["read", "deploy"]));
  });

  it("defaults to a read-only token when nothing extra is ticked", async () => {
    wrap();
    fireEvent.change(screen.getByPlaceholderText(/Token name/), { target: { value: "readonly" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createApiToken).toHaveBeenCalledWith("readonly", ["read"]));
  });
});
