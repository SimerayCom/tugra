import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import NewServerPage from "./page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team One", role: "OWNER" }] as never);
  vi.spyOn(api, "listCloudCredentials").mockResolvedValue([]);
});
const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <NewServerPage />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("Add server page", () => {
  it("has the guide '?' at the top right and the access help behind a closed disclosure", () => {
    wrap();
    expect(screen.getByRole("link", { name: "Guide: Add a server" }).getAttribute("href")).toBe("https://tugra.io/docs/add-a-server");
    const d = screen.getByText("Can't reach the server?").closest("details") as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(within(d).getAllByRole("listitem")).toHaveLength(4);
  });

  it("keeps the guide link when switching to another tab", () => {
    wrap();
    fireEvent.click(screen.getByRole("tab", { name: "Add many" }));
    expect(screen.getByRole("link", { name: "Guide: Add a server" })).toBeTruthy();
  });
});
