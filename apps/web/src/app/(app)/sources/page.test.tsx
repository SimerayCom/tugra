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

describe("Git sources: one-click layout", () => {
  it("leads with Connect GitHub and keeps manual setup under Advanced", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
    vi.spyOn(api, "listGitSources").mockResolvedValue([]);
    wrap();
    expect(await screen.findByText("Connect your first Git host")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Connect GitHub" }).length).toBe(1);
    const adv = screen.getByText("Advanced").closest("details") as HTMLDetailsElement;
    expect(adv.open).toBe(false);
    expect(adv.textContent).toContain("GitHub App you created yourself");
  });

  it("lists connected sources as cards with the team they belong to", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
    vi.spyOn(api, "listGitSources").mockResolvedValue([src()]);
    vi.spyOn(api, "listSourceRepos").mockResolvedValue([{ fullName: "acme/web", cloneUrl: "u", private: true, defaultBranch: "main" }]);
    wrap();
    expect(await screen.findByText("tugra-mrcandev")).toBeTruthy();
    expect(await screen.findByText("1 repository")).toBeTruthy();
  });
});
