import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";

const h = vi.hoisted(() => ({ user: { id: "u1" } as unknown, loading: false, replace: vi.fn() }));
vi.mock("../../../../lib/auth", () => ({ useAuth: () => ({ user: h.user, loading: h.loading }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace, push: vi.fn() }) }));

import OAuthAuthorizePage from "./page";

const QUERY = "response_type=code&client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A8123%2Fcb&code_challenge=abc&code_challenge_method=S256&state=s1&scope=read+write";

const preview = (teams = [{ id: "t1", name: "Acme", allowedScopes: ["read", "write"] }]) => ({
  client: { id: "c1", name: "Claude Code" },
  redirectUri: "http://localhost:8123/cb",
  redirectHost: "localhost:8123",
  requestedScopes: ["read", "write"],
  teams,
});

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <OAuthAuthorizePage />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("OAuth consent page", () => {
  const assign = vi.fn();
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { id: "u1" };
    h.loading = false;
    h.replace.mockClear();
    assign.mockClear();
    window.history.replaceState({}, "", `/oauth/authorize?${QUERY}`);
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, search: `?${QUERY}`, assign } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("sends a logged-out visitor to login and brings them back to the same request", async () => {
    h.user = null;
    wrap();
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(h.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(`/oauth/authorize?${QUERY}`)}`);
  });

  it("shows the client and the redirect host", async () => {
    vi.spyOn(api, "oauthPreview").mockResolvedValue(preview());
    wrap();
    expect(await screen.findByText("Connect Claude Code")).toBeTruthy();
    expect(screen.getByText("After you decide, you go back to localhost:8123.")).toBeTruthy();
  });

  it("starts with read only; the team needs a pick when there are several; write is not ticked", async () => {
    vi.spyOn(api, "oauthPreview").mockResolvedValue(preview([
      { id: "t1", name: "Acme", allowedScopes: ["read", "write", "deploy"] },
      { id: "t2", name: "Viewers", allowedScopes: ["read"] },
    ]));
    wrap();
    await screen.findByText("Connect Claude Code");
    const allow = screen.getByRole("button", { name: "Allow access" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false, false, false]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "t2" } });
    expect(allow.disabled).toBe(false);
    // Viewers: only read is allowed, every other scope is locked.
    expect(boxes.map((b) => b.disabled)).toEqual([true, true, true, true, true]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "t1" } });
    expect(boxes.map((b) => b.disabled)).toEqual([true, false, false, true, true]);
  });

  it("preselects the only team", async () => {
    vi.spyOn(api, "oauthPreview").mockResolvedValue(preview());
    wrap();
    await screen.findByText("Connect Claude Code");
    await waitFor(() => expect((screen.getByRole("button", { name: "Allow access" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("posts the team and the chosen scopes, then follows the returned URL", async () => {
    vi.spyOn(api, "oauthPreview").mockResolvedValue(preview());
    const decision = vi.spyOn(api, "oauthDecision").mockResolvedValue({ redirectTo: "http://localhost:8123/cb?code=abc&state=s1" });
    wrap();
    await screen.findByText("Connect Claude Code");
    await waitFor(() => expect((screen.getByRole("button", { name: "Allow access" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Write"));
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://localhost:8123/cb?code=abc&state=s1"));
    expect(decision).toHaveBeenCalledWith(expect.objectContaining({ client_id: "c1", state: "s1", code_challenge_method: "S256" }), { approve: true, teamId: "t1", scopes: ["read", "write"] });
  });

  it("cancel sends a denial", async () => {
    vi.spyOn(api, "oauthPreview").mockResolvedValue(preview());
    const decision = vi.spyOn(api, "oauthDecision").mockResolvedValue({ redirectTo: "http://localhost:8123/cb?error=access_denied" });
    wrap();
    await screen.findByText("Connect Claude Code");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://localhost:8123/cb?error=access_denied"));
    expect(decision.mock.calls[0][1]).toEqual({ approve: false });
  });

  it("an invalid request shows a message instead of a form", async () => {
    vi.spyOn(api, "oauthPreview").mockRejectedValue(new Error("bad"));
    wrap();
    expect(await screen.findByText("This connection request is not valid.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow access" })).toBeNull();
  });
});
