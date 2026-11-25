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
  it("asks to be opened from a run when the server or the import is missing", async () => {
    search = "serverId=srv1";
    mount();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Open this from a same-server migration run");
  });
  it("shows the takeover of the server named in the address, with the server's own name to type", async () => {
    search = "serverId=srv1&opId=op1";
    vi.spyOn(api, "getServer").mockResolvedValue({ id: "srv1", name: "olgu-box" } as never);
    vi.spyOn(api, "listInPlace").mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/No takeover yet for olgu-box/)).toBeTruthy();
  });
});
