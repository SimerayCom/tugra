import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
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
  });

  const order = () => screen.getAllByRole("link").map((a) => a.textContent).filter((x) => ["Zeta", "Alpha", "Mid"].includes(x ?? ""));

  it("sorts by name, then resources (biggest first), then created (newest first)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><I18nProvider><ProjectsPage /></I18nProvider></QueryClientProvider>);
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
