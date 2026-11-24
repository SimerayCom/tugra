import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { EnvironmentCard } from "./environment-card";
import { api } from "../lib/api";
import { subscribeToast } from "../lib/toast-bus";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <I18nProvider>{node}</I18nProvider>
  </QueryClientProvider>
);
const projects = [
  { id: "p1", teamId: "t1", name: "Shop", environments: [{ id: "e1", name: "prod" }, { id: "e2", name: "staging" }] },
  { id: "p2", teamId: "t1", name: "Blog", environments: [{ id: "e3", name: "production" }] },
  { id: "p3", teamId: "t2", name: "Other team", environments: [{ id: "e4", name: "production" }] },
];

describe("EnvironmentCard", () => {
  it("moves within the project and toasts the target project / environment", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue(projects as never);
    const move = vi.spyOn(api, "setAppEnvironment").mockResolvedValue({} as never);
    const toasts: string[] = [];
    const off = subscribeToast((x) => toasts.push(x.message));
    render(wrap(<EnvironmentCard kind="app" id="a1" environmentId="e1" />));
    await screen.findByRole("option", { name: "staging" });
    expect((screen.getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true); // nothing changed yet
    fireEvent.change(screen.getByRole("combobox", { name: "Environment" }), { target: { value: "e2" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(move).toHaveBeenCalledWith("a1", "e2"));
    await waitFor(() => expect(toasts).toContain("Moved to Shop / staging"));
    off();
  });

  it("offers only the projects of the resource's own team and lands on the other project's default environment", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue(projects as never);
    const move = vi.spyOn(api, "setDatabaseEnvironment").mockResolvedValue({} as never);
    render(wrap(<EnvironmentCard kind="database" id="d1" environmentId="e1" />));
    await screen.findByRole("option", { name: "Blog" });
    const picker = screen.getByRole("combobox", { name: "Choose a project…" }) as HTMLSelectElement;
    const names = [...picker.options].map((o) => o.textContent);
    expect(names).toContain("Blog");
    expect(names).not.toContain("Other team");
    fireEvent.change(picker, { target: { value: "Blog" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(move).toHaveBeenCalledWith("d1", "e3"));
  });
});
