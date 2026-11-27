import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { ToastProvider } from "../toast";
import { ConfirmProvider } from "../confirm";
import { ImportWizard } from "../import-wizard";
import { GitLinksPanel, GitRelinkCard, DeployKeyBlock, bucketGitLinks } from "./git-links-panel";
import { api } from "../../lib/api";
import type { ImportGitLinkRow, ImportGitLinksView, ImportPlan } from "../../lib/types";

afterEach(cleanup);

const row = (i: number, over: Partial<ImportGitLinkRow> = {}): ImportGitLinkRow => ({ itemRef: `app:s:a${i}`, name: `app-${i}`, repo: { host: "github.com", owner: "acme", name: `r${i}` }, status: "linked", sourceName: "Acme App", reason: "x", ...over });
const plan = (hosts: Array<{ host: string; apps: number }> = [{ host: "github.com", apps: 3 }]): ImportPlan => ({
  sourceKind: "coolify", mode: "copy", planHash: "a".repeat(32), warnings: [], totals: { apps: 1, databases: 0, volumes: 0, blockers: 0 },
  items: [{ itemRef: "app:s:a1", kind: "app", name: "app-1", proposed: {}, risks: [], dependsOn: [] }],
  preflight: { databases: [], services: [], appsWithVolumeData: 0, git: { hosts } },
});
// Coolify opens on the agent path by default; these tests drive the token form, one click away.
const openToken = async () => {
  const btn = await screen.findByRole("button", { name: "Connect with an API token" });
  if (btn.getAttribute("aria-pressed") !== "true") fireEvent.click(btn);
  return screen.findByLabelText("Coolify URL");
};

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></I18nProvider></QueryClientProvider>);

describe("bucketGitLinks", () => {
  it("74 apps under one org collapse to ONE owner group per status, ordered linked first", () => {
    const rows = [...Array.from({ length: 60 }, (_, i) => row(i)), ...Array.from({ length: 14 }, (_, i) => row(100 + i, { status: "needs_source", sourceName: undefined }))];
    const b = bucketGitLinks(rows);
    expect(b.map((x) => [x.status, x.total, x.owners.length])).toEqual([["linked", 60, 1], ["needs_source", 14, 1]]);
    expect(b[0].owners[0].label).toBe("github.com/acme");
  });
});

describe("GitLinksPanel", () => {
  const view: ImportGitLinksView = {
    rows: [row(1), row(2), row(3, { status: "needs_source", sourceName: undefined }), row(4, { status: "unsupported_host", sourceName: undefined, repo: { host: "gitlab.com", owner: "grp", name: "r4" } }), row(5, { status: "linked", rewriteUrl: "https://github.com/acme/r5.git" })],
    groups: [],
  };
  beforeEach(() => {
    vi.spyOn(api, "importGitLinks").mockResolvedValue(view);
  });
  afterEach(() => vi.restoreAllMocks());

  it("groups by status and owner, shows the honest GitLab note, the ssh conversion hint and the host counts", async () => {
    wrap(<GitLinksPanel sessionId="s1" targetServerId="srv1" plan={plan([{ host: "github.com", apps: 4 }, { host: "gitlab.com", apps: 1 }])} />);
    await screen.findByText("Will be linked");
    expect(api.importGitLinks).toHaveBeenCalledWith({ sessionId: "s1", targetServerId: "srv1" });
    expect(screen.getByText("No connected source can see these")).toBeTruthy();
    expect(screen.getByText("Unsupported host")).toBeTruthy();
    expect(screen.getByText(/GitLab and Bitbucket sources are not supported yet/)).toBeTruthy();
    expect(screen.getByText("Git hosts: github.com x4, gitlab.com x1")).toBeTruthy();
    for (const d of Array.from(document.querySelectorAll("details"))) d.setAttribute("open", "");
    expect(screen.getAllByText("github.com/acme").length).toBeGreaterThan(0);
    expect(screen.getByText(/SSH URL will be converted to https/)).toBeTruthy();
  });

  it("Re-check calls the resolver again; Connect GitHub opens the Git sources page in a NEW tab (the wizard session survives)", async () => {
    wrap(<GitLinksPanel sessionId="s1" targetServerId="srv1" plan={plan()} />);
    await screen.findByText("Will be linked");
    const link = screen.getByText("Connect GitHub").closest("a")!;
    expect(link.getAttribute("href")).toBe("/sources");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await waitFor(() => expect(api.importGitLinks).toHaveBeenCalledTimes(2));
  });

  it("an error is shown loudly, not as an empty panel", async () => {
    vi.spyOn(api, "importGitLinks").mockImplementation(() => Promise.reject(new Error("boom")));
    wrap(<GitLinksPanel sessionId="s1" targetServerId="srv1" plan={plan()} />);
    await screen.findByText("Could not check the repositories");
  });
});

describe("GitRelinkCard", () => {
  afterEach(() => vi.restoreAllMocks());
  it("links covered apps and lets the operator pick a source for an ambiguous one (explicit choice sent)", async () => {
    const spy = vi.spyOn(api, "relinkImportGit")
      .mockResolvedValueOnce({ linked: 1, results: [
        { itemRef: "app:s:a1", name: "web", outcome: "linked", status: "linked", sourceName: "Acme" },
        { itemRef: "app:s:a2", name: "api", outcome: "not_linked", status: "ambiguous", candidates: [{ id: "g1", name: "One" }, { id: "g2", name: "Two" }] },
      ] })
      .mockResolvedValueOnce({ linked: 1, results: [{ itemRef: "app:s:a2", name: "api", outcome: "linked", status: "linked", sourceName: "Two" }] });
    wrap(<GitRelinkCard opId="op1" />);
    fireEvent.click(screen.getByRole("button", { name: "Link now" }));
    await screen.findByText("web");
    expect(spy).toHaveBeenCalledWith("op1", undefined);
    const pick = screen.getByLabelText("Pick a source") as HTMLSelectElement;
    const linkBtn = screen.getByRole("button", { name: "Link" }) as HTMLButtonElement;
    expect(linkBtn.disabled).toBe(true);
    fireEvent.change(pick, { target: { value: "g2" } });
    fireEvent.click(linkBtn);
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("op1", { "app:s:a2": "g2" }));
  });
});

describe("DeployKeyBlock", () => {
  it("shows the public key with a copy button", () => {
    wrap(<DeployKeyBlock publicKey="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 tugra" />);
    expect(screen.getByText("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 tugra")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy key" })).toBeTruthy();
    expect(screen.getByText("Add this public deploy key to the repository")).toBeTruthy();
  });
});

describe("ImportWizard — git panel gating and timeline", () => {
  beforeEach(() => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team One" }] as never);
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv1", name: "Server A", teamId: "t1", status: "ONLINE", clusterId: null, tags: [] }] as never);
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
  });
  afterEach(() => vi.restoreAllMocks());
  const connect = async () => {
    await openToken();
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect & preview" }) as HTMLButtonElement).disabled).toBe(false)); // the connection team has loaded
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
  };

  it("a plan with no git hosts never calls the resolver", async () => {
    vi.spyOn(api, "importPlan").mockResolvedValue(plan([]));
    const spy = vi.spyOn(api, "importGitLinks");
    wrap(<ImportWizard />);
    await connect();
    expect(spy).not.toHaveBeenCalled();
  });

  it("a plan with git hosts shows the panel before Apply; the timeline shows the deploy key and the Link-now card for unlinked apps", async () => {
    vi.spyOn(api, "importPlan").mockResolvedValue(plan());
    vi.spyOn(api, "importGitLinks").mockResolvedValue({ rows: [row(1)], groups: [] });
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getMigrateCommand").mockResolvedValue({ opId: "op1", active: false, expiresAt: null, commandTemplate: "x" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue({
      id: "op1", sourceKind: "coolify", serverId: "srv1", planHash: "a".repeat(32), status: "SUCCEEDED", cancelRequested: false, createdAt: "2026-10-18T00:00:00.000Z",
      totals: { total: 1, done: 1, failed: 0, skipped: 0, running: 0, pending: 0, cancelled: 0, rolledBack: 0 },
      tasks: [{ itemRef: "app:s:a1", kind: "app", name: "web", status: "DONE", resourceType: "application", resourceId: "x", message: "git: SSH deploy key generated", git: { status: "ssh_deploy_key", deployKeyPublic: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 tugra" }, startedAt: null, finishedAt: null }],
    });
    wrap(<ImportWizard />);
    await connect();
    await screen.findByText("Will be linked");
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 tugra");
    expect(screen.getByRole("button", { name: "Link now" })).toBeTruthy();
  });
});
