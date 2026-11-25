import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ToastProvider } from "../../../../components/toast";
import { api } from "../../../../lib/api";
import Page from "./page";

let search = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <ToastProvider>
          <Page />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("in-place takeover page", () => {
  it("asks to be opened from a server page or the checklist when the server is missing", async () => {
    search = "opId=op1";
    mount();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Open this from a server page or the Move off Coolify checklist");
  });
  it("opens from the checklist with only the server: it shows the takeover and cannot plan a new one", async () => {
    search = "serverId=srv1";
    vi.spyOn(api, "getServer").mockResolvedValue({ id: "srv1", name: "olgu-box" } as never);
    vi.spyOn(api, "listInPlace").mockResolvedValue([]);
    mount();
    expect(await screen.findByTestId("takeover-needs-run")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan the takeover" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Move off Coolify" }).getAttribute("href")).toBe("/import/move-off-coolify");
  });
  it("shows the takeover of the server named in the address, with the server's own name to type", async () => {
    search = "serverId=srv1&opId=op1";
    vi.spyOn(api, "getServer").mockResolvedValue({ id: "srv1", name: "olgu-box" } as never);
    vi.spyOn(api, "listInPlace").mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/No takeover yet for olgu-box/)).toBeTruthy();
  });
});
