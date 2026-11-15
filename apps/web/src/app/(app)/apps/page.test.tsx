import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { Application } from "../../../lib/types";

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav, usePathname: () => "/apps", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import AppsPage from "./page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mk = (id: string, name: string, over: Partial<Application> = {}): Application =>
  ({ id, name, source: "IMAGE", image: "nginx", gitBranch: null, status: "RUNNING", teamId: "t1", tags: [], projectName: null, environmentName: null, containerHealth: { state: "healthy", checkType: "NONE", containers: 1 }, iconUpdatedAt: null, templateSlug: null, templateLogo: null, imageUpdate: null, ...over }) as unknown as Application;

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <AppsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const rowNames = () => screen.getAllByRole("link").map((a) => a.textContent).filter((x) => ["alpha", "bravo", "charlie"].includes(x ?? ""));

describe("apps list", () => {
  beforeEach(() => {
    vi.spyOn(api, "listApps").mockResolvedValue([
      mk("a", "charlie", { tags: ["prod"], status: "FAILED" }),
      mk("b", "alpha", { tags: ["prod", "api"] }),
      mk("c", "bravo", { tags: ["dev"] }),
    ]);
  });

  it("sorts by the clicked column and flips direction on a second click", async () => {
    show();
    await screen.findByText("alpha");
    expect(rowNames()).toEqual(["charlie", "alpha", "bravo"]); // API order until a sort is picked
    const nameBtn = screen.getByRole("button", { name: /^Name/ });
    fireEvent.click(nameBtn);
    expect(rowNames()).toEqual(["alpha", "bravo", "charlie"]);
    fireEvent.click(nameBtn);
    expect(rowNames()).toEqual(["charlie", "bravo", "alpha"]);
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    expect(rowNames()[0]).toBe("charlie"); // FAILED first
  });

  it("clicking a tag chip on a row filters the list to that tag, clicking again clears it", async () => {
    show();
    await screen.findByText("alpha");
    const row = screen.getByText("bravo").closest(".tg-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Filter by tag dev" }));
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("charlie")).toBeNull();
    expect(screen.getByText("bravo")).toBeTruthy();
    expect(nav.push).not.toHaveBeenCalled(); // the chip click must not navigate the row
    fireEvent.click(screen.getAllByRole("button", { name: "Filter by tag dev" })[0]);
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("the app name is a real link (keyboard path into the app)", async () => {
    show();
    const link = (await screen.findByText("alpha")).closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/apps/b");
  });
});
