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

describe("EnvironmentCard", () => {
  it("toasts the target project / environment after a move", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([
      { id: "p1", name: "Shop", environments: [{ id: "e1", name: "prod" }, { id: "e2", name: "staging" }] },
    ] as never);
    const move = vi.spyOn(api, "setAppEnvironment").mockResolvedValue({} as never);
    const toasts: string[] = [];
    const off = subscribeToast((x) => toasts.push(x.message));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <I18nProvider>
          <EnvironmentCard kind="app" id="a1" environmentId="e1" />
        </I18nProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("option", { name: "Shop / staging" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "e2" } });
    await waitFor(() => expect(move).toHaveBeenCalledWith("a1", "e2"));
    await waitFor(() => expect(toasts).toContain("Moved to Shop / staging"));
    off();
  });
});
