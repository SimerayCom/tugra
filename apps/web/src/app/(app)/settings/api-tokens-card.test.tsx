import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import { subscribeToast } from "../../../lib/toast-bus";
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

describe("ApiTokensCard expiry, rename and rotate", () => {
  const day = 86_400_000;
  const tok = (id: string, name: string, expiresInMs: number | null) => ({
    id, name, prefix: "tugra_pat_", scopes: ["read" as const], expiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs).toISOString(), lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z",
  });
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows an amber 'N days left' badge at <=14 days, a plain date beyond, 'Expired' when past, and nothing alarming without expiry", async () => {
    vi.spyOn(api, "listApiTokens").mockResolvedValue([tok("a", "soon", 3 * day - 1000), tok("b", "later", 60 * day), tok("c", "dead", -day), tok("d", "forever", null), tok("e", "tomorrow", day / 2)]);
    wrap();
    expect(await screen.findByText("3 days left")).toBeTruthy();
    expect(screen.getByText("1 day left")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.getByText("no expiry")).toBeTruthy();
    expect(screen.getByText(/^expires /)).toBeTruthy();
    expect(screen.queryByText("60 days left")).toBeNull();
  });

  it("does not offer Rotate on an expired token (the hub refuses it)", async () => {
    vi.spyOn(api, "listApiTokens").mockResolvedValue([tok("c", "dead", -day), tok("a", "alive", 30 * day)]);
    wrap();
    await screen.findByText("dead");
    expect(screen.queryByRole("button", { name: "Rotate token dead" })).toBeNull();
    expect(screen.getByRole("button", { name: "Rotate token alive" })).toBeTruthy();
  });

  it("renames inline via PATCH and refreshes the list", async () => {
    const list = vi.spyOn(api, "listApiTokens").mockResolvedValue([tok("a", "ci-old", null)]);
    const rename = vi.spyOn(api, "renameApiToken").mockResolvedValue(tok("a", "ci-new", null));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Rename token ci-old" }));
    const input = screen.getByLabelText("New token name");
    fireEvent.change(input, { target: { value: "  ci-new " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(rename).toHaveBeenCalledWith("a", "ci-new"));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
  });

  it("rotates after confirmation and shows the new secret once", async () => {
    vi.spyOn(api, "listApiTokens").mockResolvedValue([tok("a", "ci", null)]);
    const rotate = vi.spyOn(api, "rotateApiToken").mockResolvedValue({ token: "tugra_pat_rotated", view: tok("a", "ci", null) });
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Rotate token ci" }));
    await waitFor(() => expect(rotate).toHaveBeenCalledWith("a"));
    expect(await screen.findByText("tugra_pat_rotated")).toBeTruthy();
  });

  it("sends the optional expiry only when filled in", async () => {
    vi.spyOn(api, "listApiTokens").mockResolvedValue([]);
    const create = vi.spyOn(api, "createApiToken").mockResolvedValue({ token: "t", view: tok("n", "x", null) });
    wrap();
    fireEvent.change(screen.getByPlaceholderText(/Token name/), { target: { value: "ci" } });
    fireEvent.change(screen.getByLabelText("Expires in (days, optional)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("ci", ["read"], 30));
  });
});

describe("ApiTokensCard revoke feedback", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "listApiTokens").mockResolvedValue([{ id: "t1", name: "CI token", prefix: "tugra_pat_", scopes: ["read"], expiresAt: null, lastUsedAt: null, createdAt: "2026-11-15T00:00:00Z" }] as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("names the token in the toast after a confirmed revoke", async () => {
    vi.spyOn(api, "deleteApiToken").mockResolvedValue({ ok: true } as never);
    const toasts: string[] = [];
    const off = subscribeToast((x) => toasts.push(x.message));
    wrap();
    await screen.findByText("CI token");
    fireEvent.click(screen.getByRole("button", { name: /^(Revoke|Delete)$/ }));
    await waitFor(() => expect(toasts).toContain("CI token revoked"));
    off();
  });
});
