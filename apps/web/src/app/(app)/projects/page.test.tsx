import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import { ConfirmProvider } from "../../../components/confirm";
import { TeamScopeProvider } from "../../../components/team-scope";
import type { Project } from "../../../lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import ProjectsPage from "./page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const proj = (id: string, name: string, createdAt: string, appCount: number): Project =>
  ({ id, teamId: "t1", name, isDefault: false, role: "OWNER", canWrite: true, iconUpdatedAt: null, createdAt, environments: [{ id: `${id}e`, name: "prod", isDefault: true, appCount, dbCount: 0, createdAt }] }) as unknown as Project;

describe("projects list sorting", () => {
  beforeEach(() => {
    vi.spyOn(api, "listProjects").mockResolvedValue([
      proj("p1", "Zeta", "2026-02-01T00:00:00Z", 9),
      proj("p2", "Alpha", "2026-01-01T00:00:00Z", 1),
      proj("p3", "Mid", "2026-03-01T00:00:00Z", 4),
    ]);
    vi.spyOn(api, "listTeams").mockResolvedValue([]);
    vi.spyOn(api, "listEmptyDefaultProjects").mockResolvedValue([]);
  });

  const order = () => screen.getAllByRole("link").map((a) => a.textContent).filter((x) => ["Zeta", "Alpha", "Mid"].includes(x ?? ""));

  it("sorts by name, then resources (biggest first), then created (newest first)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><I18nProvider><TeamScopeProvider><ConfirmProvider><ProjectsPage /></ConfirmProvider></TeamScopeProvider></I18nProvider></QueryClientProvider>);
    await screen.findByText("Zeta");
    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));
    expect(order()).toEqual(["Alpha", "Mid", "Zeta"]);
    fireEvent.click(screen.getByRole("button", { name: /^Resources/ }));
    expect(order()).toEqual(["Zeta", "Mid", "Alpha"]);
    fireEvent.click(screen.getByRole("button", { name: /^Created/ }));
    expect(order()).toEqual(["Mid", "Zeta", "Alpha"]);
    fireEvent.click(screen.getByRole("button", { name: /^Created/ })); // flip to oldest first
    expect(order()).toEqual(["Alpha", "Zeta", "Mid"]);
  });
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><I18nProvider><TeamScopeProvider><ConfirmProvider><ProjectsPage /></ConfirmProvider></TeamScopeProvider></I18nProvider></QueryClientProvider>);
}

describe("projects page: team context and first run", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(api, "listEmptyDefaultProjects").mockResolvedValue([]);
  });

  it("a team without a project is invited to create its first one, named after the team, or to import", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
    const create = vi.spyOn(api, "createProject").mockResolvedValue({} as never);
    renderPage();
    await screen.findByText("Create your first project");
    expect(screen.getByRole("link", { name: "Import" }).getAttribute("href")).toBe("/import");
    fireEvent.click(await screen.findByRole("button", { name: "Create “Acme”" }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith("t1", "Acme"));
  });

  it("an empty team that is scoped on a multi-team account gets the first-project call, not a dead end", async () => {
    localStorage.setItem("tugra.teamScope", "t2");
    vi.spyOn(api, "listProjects").mockResolvedValue([proj("p1", "Shop", "2026-01-01T00:00:00Z", 1)]);
    vi.spyOn(api, "listTeams").mockResolvedValue([
      { id: "t1", name: "Acme", role: "OWNER" },
      { id: "t2", name: "Zed", role: "OWNER" },
    ] as never);
    const create = vi.spyOn(api, "createProject").mockResolvedValue({} as never);
    renderPage();
    await screen.findByText("Create your first project");
    expect(screen.queryByText("Shop")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Create “Zed”" }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith("t2", "Zed"));
  });

  it("with several teams the list is grouped by team and every project carries its team badge", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([
      { ...proj("p1", "Shop", "2026-01-01T00:00:00Z", 1), teamId: "t1" },
      { ...proj("p2", "Blog", "2026-01-02T00:00:00Z", 1), teamId: "t2" },
    ]);
    vi.spyOn(api, "listTeams").mockResolvedValue([
      { id: "t1", name: "Acme", role: "OWNER" },
      { id: "t2", name: "Zed", role: "OWNER" },
    ] as never);
    renderPage();
    await screen.findByText("Shop");
    expect(screen.getByRole("button", { name: /Acme/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Zed/ })).toBeTruthy();
    // collapsing a team hides its projects
    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
    expect(screen.queryByText("Shop")).toBeNull();
    expect(screen.getByText("Blog")).toBeTruthy();
  });

  it("a single team shows neither group headers nor team badges", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([proj("p1", "Shop", "2026-01-01T00:00:00Z", 1)]);
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
    renderPage();
    await screen.findByText("Shop");
    expect(screen.queryByRole("button", { name: /Acme/ })).toBeNull();
  });
});
