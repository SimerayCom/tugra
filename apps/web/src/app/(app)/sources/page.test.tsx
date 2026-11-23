import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { GitSource } from "../../../lib/types";

let owner = true;
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { isInstanceOwner: owner } }) }));
import SourcesPage from "./page";
import { ConfirmProvider } from "../../../components/confirm";
import { ToastProvider } from "../../../components/toast";

const src = (over: Partial<GitSource> = {}): GitSource => ({
  id: "g1", name: "tugra-mrcandev", teamId: "t1", provider: "github", kind: "github", appId: "5891909", appSlug: null,
  installationId: "185102883", htmlUrl: null, apiUrl: null, hasToken: true, cloneHost: "github.com", createdAt: "2026-11-23T00:00:00Z",
  canWrite: true, sharedAllTeams: false, ...over,
});

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "listTeams").mockResolvedValue([] as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); owner = true; });
const wrap = () => render(<QueryClientProvider client={qc}><I18nProvider><ToastProvider><ConfirmProvider><SourcesPage /></ConfirmProvider></ToastProvider></I18nProvider></QueryClientProvider>);

describe("Git sources: share with every team", () => {
  it("the instance owner shares a source with one click", async () => {
    vi.spyOn(api, "listGitSources").mockResolvedValue([src()]);
    const set = vi.spyOn(api, "setGitSourceSharing").mockResolvedValue(src({ sharedAllTeams: true }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Share with all teams" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("g1", true));
  });

  it("a shared source shows the All teams badge and offers Stop sharing", async () => {
    vi.spyOn(api, "listGitSources").mockResolvedValue([src({ sharedAllTeams: true })]);
    wrap();
    expect(await screen.findByText("All teams")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeTruthy();
  });

  it("a non-owner never sees the share switch", async () => {
    owner = false;
    vi.spyOn(api, "listGitSources").mockResolvedValue([src()]);
    wrap();
    expect(await screen.findByText("tugra-mrcandev")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share with all teams" })).toBeNull();
  });
});
