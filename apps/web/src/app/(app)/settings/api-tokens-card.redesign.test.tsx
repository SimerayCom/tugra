import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { ApiToken, PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({
  user: { isInstanceOwner: false } as Partial<PublicUser>,
  confirm: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../../../components/confirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../../../lib/clipboard", () => ({ copyText: h.copy }));
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

const tok = (over: Partial<ApiToken> = {}): ApiToken => ({
  id: "t1", name: "CI", prefix: "tugra_pat_ab", scopes: ["read", "deploy"], expiresAt: null,
  lastUsedAt: null, createdAt: "2026-11-01T00:00:00Z", createdBy: { id: "u1", name: "Ada Example", email: "ada@example.com" }, ...over,
});
const settings = (apiEnabled: boolean) => ({ apiEnabled, apiAllowedIps: [], publicUrl: null, acmeEmail: null });

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  h.user = { isInstanceOwner: false };
  h.confirm.mockReset().mockResolvedValue(true);
  h.copy.mockReset().mockResolvedValue(true);
  vi.spyOn(api, "listApiTokens").mockResolvedValue([]);
  vi.spyOn(api, "getInstanceSettings").mockResolvedValue(settings(true));
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("tokens table", () => {
  it("shows name, scope badges, last used, expiry and who created it", async () => {
    vi.spyOn(api, "listApiTokens").mockResolvedValue([tok({ lastUsedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() })]);
    wrap();
    const table = await screen.findByRole("table", { name: "API tokens" });
    for (const col of ["Name", "Access", "Last used", "Expires", "Created by"]) {
      expect(within(table).getByRole("columnheader", { name: col })).toBeTruthy();
    }
    expect(within(table).getByText("CI")).toBeTruthy();
    expect(within(table).getByText("Read")).toBeTruthy();
    expect(within(table).getByText("Deploy")).toBeTruthy();
    expect(within(table).getByText("3h ago")).toBeTruthy();
    expect(within(table).getByText("no expiry")).toBeTruthy();
    expect(within(table).getByText("Ada Example")).toBeTruthy();
  });

  it("says Never for an unused token and falls back to the email when the owner has no name", async () => {
    vi.spyOn(api, "listApiTokens").mockResolvedValue([tok({ createdBy: { id: "u1", name: null, email: "ada@example.com" } })]);
    wrap();
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
  });
});

describe("one-time reveal", () => {
  beforeEach(() => {
    vi.spyOn(api, "createApiToken").mockResolvedValue({ token: "tugra_pat_SECRETVALUE", view: tok() });
  });

  const create = async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("tugra_pat_SECRETVALUE");
  };

  it("shows the token once, confirms the copy, and lets you finish without a prompt after copying", async () => {
    await create();
    expect(screen.getByText("This is the only time it's shown.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(h.copy).toHaveBeenCalledWith("tugra_pat_SECRETVALUE"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText("tugra_pat_SECRETVALUE")).toBeNull());
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("asks before closing when the token was never copied, and keeps it if you back out", async () => {
    h.confirm.mockResolvedValue(false);
    await create();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Close without copying?" })));
    expect(screen.getByText("tugra_pat_SECRETVALUE")).toBeTruthy();
    h.confirm.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText("tugra_pat_SECRETVALUE")).toBeNull());
  });

  it("does not count a failed copy as saved", async () => {
    h.copy.mockResolvedValue(false);
    h.confirm.mockResolvedValue(false);
    await create();
    fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(h.copy).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalled());
  });
});

describe("Token for MCP preset", () => {
  it("creates a read-only 90-day token and offers the exact claude mcp add command", async () => {
    const createFn = vi.spyOn(api, "createApiToken").mockResolvedValue({ token: "tugra_pat_MCPTOKEN", view: tok({ scopes: ["read"] }) });
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Token for MCP" }));
    // No scope picker for the preset: it is always read-only.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("MCP");
    fireEvent.click(screen.getByRole("button", { name: "Create MCP token" }));
    await waitFor(() => expect(createFn).toHaveBeenCalledWith("MCP", ["read"], 90));

    const cmd = await screen.findByLabelText("Command to add this hub to Claude Code");
    // The command (and its Copy button) only appear once the hub's public origin has resolved.
    await waitFor(() => expect(cmd.textContent).toMatch(/^claude mcp add /));
    expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(false);
    expect(cmd.textContent).toMatch(/^claude mcp add --transport http tugra https?:\/\/[^ ]+\/api\/v1\/mcp --header "Authorization: Bearer tugra_pat_MCPTOKEN"$/);
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(h.copy).toHaveBeenCalledWith(cmd.textContent));
    // Copying the command (which embeds the token) counts as saving it.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByLabelText("Command to add this hub to Claude Code")).toBeNull());
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("does not show the command for a normal token", async () => {
    vi.spyOn(api, "createApiToken").mockResolvedValue({ token: "tugra_pat_plain", view: tok() });
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("tugra_pat_plain");
    expect(screen.queryByLabelText("Command to add this hub to Claude Code")).toBeNull();
  });
});

describe("API access off notice", () => {
  it("warns the owner and turns API access on in one click", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue(settings(false));
    const upd = vi.spyOn(api, "updateInstanceSettings").mockResolvedValue(settings(true));
    wrap();
    expect(await screen.findByText("API access is off: tokens will not work right now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(upd).toHaveBeenCalledWith({ apiEnabled: true }));
  });

  it("is hidden when API access is on", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    await waitFor(() => expect(api.getInstanceSettings).toHaveBeenCalled());
    expect(screen.queryByText(/API access is off/)).toBeNull();
  });

  it("is never shown to (nor fetched for) someone who cannot change the setting", async () => {
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue(settings(false));
    wrap();
    await screen.findByText("No API tokens yet");
    expect(api.getInstanceSettings).not.toHaveBeenCalled();
    expect(screen.queryByText(/API access is off/)).toBeNull();
  });
});

describe("usage history", () => {
  it("loads and lists IP, time, tool and client for a token on demand", async () => {
    vi.spyOn(api, "listApiTokens").mockResolvedValue([tok()]);
    const usage = vi.spyOn(api, "listApiTokenUsage").mockResolvedValue([
      { id: "u1", at: new Date(Date.now() - 120_000).toISOString(), ip: "203.0.113.7", userAgent: "claude-code/1.0", action: "mcp:list_servers", count: 4 },
      { id: "u2", at: new Date(Date.now() - 7_200_000).toISOString(), ip: null, userAgent: null, action: "GET /api/v1/apps", count: 1 },
    ]);
    wrap();
    const btn = await screen.findByRole("button", { name: "Show usage of token CI" });
    expect(usage).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(await screen.findByText("203.0.113.7")).toBeTruthy();
    expect(usage).toHaveBeenCalledWith("t1");
    expect(screen.getByText("mcp:list_servers")).toBeTruthy();
    expect(screen.getByText("×4")).toBeTruthy();
    expect(screen.getByText("claude-code/1.0")).toBeTruthy();
    expect(screen.getByText("GET /api/v1/apps")).toBeTruthy();
    expect(screen.getByText("The last 50 calls. The token itself is never stored.")).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByText("203.0.113.7")).toBeNull());
  });

  it("shows an empty state for a token nobody has used", async () => {
    vi.spyOn(api, "listApiTokens").mockResolvedValue([tok()]);
    vi.spyOn(api, "listApiTokenUsage").mockResolvedValue([]);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Show usage of token CI" }));
    expect(await screen.findByText("No calls yet.")).toBeTruthy();
  });
});
