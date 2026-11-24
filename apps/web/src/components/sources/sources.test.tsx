import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import type { GitSource } from "../../lib/types";
import { ToastProvider } from "../toast";

const post = vi.fn();
vi.mock("../../lib/github-manifest", async (orig) => ({ ...(await orig<typeof import("../../lib/github-manifest")>()), postManifestToGithub: (...a: unknown[]) => post(...a) }));
const nav = { replace: vi.fn() };
let search = "";
vi.mock("next/navigation", () => ({ useRouter: () => nav, useSearchParams: () => new URLSearchParams(search) }));

import { ConnectGithub } from "./connect-github";
import { GitSourceCard } from "./git-source-card";
import { PemDrop } from "./pem-drop";
import { GithubReturn } from "./github-return";

const team = (id: string, name: string, role = "OWNER") => ({ id, name, role });
const src = (over: Partial<GitSource> = {}): GitSource => ({
  id: "g1", name: "acme-deploy", teamId: "t1", provider: "github", kind: "github", appId: "5", appSlug: "acme-deploy", installationId: "10",
  htmlUrl: null, apiUrl: null, hasToken: true, cloneHost: "github.com", createdAt: "2026-11-23T00:00:00Z", canWrite: true, sharedAllTeams: false,
  installations: [{ installationId: "10", accountLogin: "alice", accountType: "User", avatarUrl: "https://avatars.example.com/a" }, { installationId: "20", accountLogin: "acme-inc", accountType: "Organization", avatarUrl: null }],
  webhookUrl: "https://hub.example.com/webhooks/github/g1", hasWebhook: true, ...over,
});

let qc: QueryClient;
beforeEach(() => { qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); post.mockReset(); nav.replace.mockReset(); search = ""; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={qc}><I18nProvider><ToastProvider>{ui}</ToastProvider></I18nProvider></QueryClientProvider>);

describe("ConnectGithub", () => {
  it("makes the audience an explicit choice when there are several teams (no silent default)", async () => {
    const start = vi.spyOn(api, "startGithubManifest").mockResolvedValue({ postUrl: "https://github.com/settings/apps/new?state=s", manifest: { name: "x" }, webhookActive: true });
    wrap(<ConnectGithub teams={[team("t1", "Acme"), team("t2", "Beta")]} isOwner={false} />);
    const btn = screen.getByRole("button", { name: "Connect GitHub" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Who can use it"), { target: { value: "t2" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(start).toHaveBeenCalledWith({ teamId: "t2", name: undefined, org: undefined, anyAccount: undefined, sharedAllTeams: undefined }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("https://github.com/settings/apps/new?state=s", { name: "x" }));
  });

  it("only the instance owner can pick every team, and nothing is preselected for them", () => {
    wrap(<ConnectGithub teams={[team("t1", "Acme")]} isOwner />);
    const sel = screen.getByLabelText("Who can use it") as HTMLSelectElement;
    expect(sel.value).toBe("");
    expect(Array.from(sel.options).map((o) => o.textContent)).toContain("Every team");
  });

  it("an organization needs a valid name before it can connect", async () => {
    const start = vi.spyOn(api, "startGithubManifest").mockResolvedValue({ postUrl: "https://github.com/organizations/acme-inc/settings/apps/new?state=s", manifest: {}, webhookActive: true });
    wrap(<ConnectGithub teams={[team("t1", "Acme")]} isOwner={false} />);
    const btn = screen.getByRole("button", { name: "Connect GitHub" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false); // one team: preselected, personal account
    fireEvent.change(screen.getByLabelText("GitHub account"), { target: { value: "org" } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "-bad" } });
    expect(screen.getByText("Use letters, numbers and single hyphens.")).toBeTruthy();
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "acme-inc" } });
    fireEvent.click(btn);
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ teamId: "t1", org: "acme-inc" })));
  });

  it("explains the auto-filled redirect, setup and webhook URLs in one line each", () => {
    wrap(<ConnectGithub teams={[team("t1", "Acme")]} isOwner={false} />);
    expect(screen.getByText(/^Redirect URL:/)).toBeTruthy();
    expect(screen.getByText(/^Setup URL:/)).toBeTruthy();
    expect(screen.getByText(/^Webhook URL:/)).toBeTruthy();
  });

  it("renders nothing for a user who cannot write in any team", () => {
    const { container } = wrap(<ConnectGithub teams={[team("t1", "Acme", "VIEWER")]} isOwner={false} />);
    expect(container.textContent).toBe("");
  });
});

describe("GitSourceCard", () => {
  it("shows provider, accounts, status, repo count and a searchable repo list", async () => {
    vi.spyOn(api, "listSourceRepos").mockResolvedValue([
      { fullName: "alice/web", cloneUrl: "u", private: true, defaultBranch: "main" },
      { fullName: "acme-inc/api", cloneUrl: "u", private: false, defaultBranch: "main" },
      { fullName: "acme-inc/docs", cloneUrl: "u", private: false, defaultBranch: "main" },
    ]);
    wrap(<GitSourceCard source={src()} teamName="Acme" isOwner={false} onDelete={() => {}} />);
    expect(screen.getByText("acme-deploy")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("acme-inc")).toBeTruthy();
    expect(await screen.findByText("3 repositories")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show repositories" }));
    fireEvent.change(screen.getByLabelText("Search repositories"), { target: { value: "DOCS" } });
    expect(screen.getByText("acme-inc/docs")).toBeTruthy();
    expect(screen.queryByText("alice/web")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search repositories"), { target: { value: "zzz" } });
    expect(screen.getByText("No repository matches.")).toBeTruthy();
  });

  it("an App without an installation says so and offers Install; adding an account starts another install", async () => {
    vi.spyOn(api, "listSourceRepos").mockResolvedValue([]);
    const inst = vi.spyOn(api, "startGithubInstall").mockResolvedValue({ installUrl: "https://evil.example.com/x" });
    wrap(<GitSourceCard source={src({ installationId: null, installations: [] })} teamName="Acme" isOwner={false} onDelete={() => {}} />);
    expect(screen.getByText("Needs install")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show repositories" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install on GitHub" }));
    await waitFor(() => expect(inst).toHaveBeenCalledWith("g1"));
  });

  it("a shared source is labelled for every team and a viewer sees no actions", () => {
    vi.spyOn(api, "listSourceRepos").mockResolvedValue([]);
    wrap(<GitSourceCard source={src({ sharedAllTeams: true, canWrite: false })} teamName="Other" isOwner={false} onDelete={() => {}} />);
    expect(screen.getByText("All teams")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("warns when the webhook URL is not reachable from the internet", () => {
    vi.spyOn(api, "listSourceRepos").mockResolvedValue([]);
    wrap(<GitSourceCard source={src({ webhookUrl: "http://localhost:3000/webhooks/github/g1" })} teamName="Acme" isOwner={false} onDelete={() => {}} />);
    expect(screen.getByText(/push-to-deploy is off/)).toBeTruthy();
  });
});

describe("PemDrop", () => {
  const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";
  it("reads a dropped .pem and hands the key up", async () => {
    const onChange = vi.fn();
    wrap(<PemDrop id="k" value="" onChange={onChange} />);
    const zone = screen.getByText("Drop the .pem file here, or choose it").parentElement!;
    const file = new File([PEM], "app.pem", { type: "text/plain" });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(PEM));
  });

  it("rejects a file that is not a private key", async () => {
    const onChange = vi.fn();
    wrap(<PemDrop id="k" value="" onChange={onChange} />);
    fireEvent.drop(screen.getByText("Drop the .pem file here, or choose it").parentElement!, { dataTransfer: { files: [new File(["hello"], "notes.txt")] } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never prints the key once loaded and can remove it", () => {
    const onChange = vi.fn();
    wrap(<PemDrop id="k" value={PEM} onChange={onChange} />);
    expect(screen.queryByText(/BEGIN PRIVATE KEY/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("GithubReturn", () => {
  it("manifest: completes once with the code and state, then sends the user to install", async () => {
    search = "code=abc&state=st1";
    const complete = vi.spyOn(api, "completeGithubManifest").mockResolvedValue({ source: src(), installUrl: "https://github.com/apps/acme-deploy/installations/new?state=i" });
    const assign = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
    wrap(<GithubReturn mode="manifest" />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/apps/acme-deploy/installations/new?state=i"));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ code: "abc", state: "st1" });
  });

  it("install: records the installation and returns to Git Sources", async () => {
    search = "installation_id=555&setup_action=install&state=st2";
    const cap = vi.spyOn(api, "captureGithubInstallation").mockResolvedValue(src());
    wrap(<GithubReturn mode="install" />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/sources"));
    expect(cap).toHaveBeenCalledWith({ state: "st2", installationId: "555" });
  });

  it("an expired or reused link shows a clear error and a way back", async () => {
    search = "code=abc&state=old";
    vi.spyOn(api, "completeGithubManifest").mockRejectedValue(new Error("invalid or expired state — start again"));
    wrap(<GithubReturn mode="manifest" />);
    expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Git Sources" })).toBeTruthy();
  });

  it("a bare visit (nothing from GitHub) does not call the API", () => {
    search = "";
    const complete = vi.spyOn(api, "completeGithubManifest");
    wrap(<GithubReturn mode="manifest" />);
    expect(screen.getByText(/did not send anything back/)).toBeTruthy();
    expect(complete).not.toHaveBeenCalled();
  });
});
