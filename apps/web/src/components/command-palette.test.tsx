import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { CommandPalette } from "./command-palette";
import { api } from "../lib/api";
import type { Application, Database, DomainView, ServerView } from "../lib/types";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(cleanup);
let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
  push.mockReset();
  // jsdom has no matchMedia (useIsMobile reads it); provide a desktop stub.
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const dests = [{ labelKey: "nav.apps", href: "/apps" }, { labelKey: "nav.servers", href: "/servers" }];

function stubLists() {
  vi.spyOn(api, "listApps").mockResolvedValue([{ id: "a1", name: "Shopfront", teamId: "t1", status: "RUNNING", domain: null, projectName: null, environmentName: null }] as unknown as Application[]);
  vi.spyOn(api, "listServers").mockResolvedValue([] as unknown as ServerView[]);
  vi.spyOn(api, "listDatabases").mockResolvedValue([] as unknown as Database[]);
  vi.spyOn(api, "listDomains").mockResolvedValue([] as unknown as DomainView[]);
}

describe("CommandPalette", () => {
  it("renders a combobox search input + navigates on Enter", async () => {
    stubLists();
    wrap(<CommandPalette dests={dests} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    expect(input).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" }); // first flat item (a nav dest) is active
    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it("fuzzy-filters to a live app and opens it", async () => {
    stubLists();
    wrap(<CommandPalette dests={dests} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "shop" } });
    // The label is split into <mark>/<span> runs for highlighting, so match by the option's id, not whole text.
    const opt = await waitFor(() => { const el = document.getElementById("cp-opt-app:a1"); if (!el) throw new Error("not yet"); return el; });
    fireEvent.click(opt);
    expect(push).toHaveBeenCalledWith("/apps/a1");
  });

  it("Enter with no results does nothing", async () => {
    stubLists();
    wrap(<CommandPalette dests={dests} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzzzzz" } });
    await waitFor(() => expect(screen.queryByText("Shopfront")).toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).not.toHaveBeenCalled();
  });

  it("fleet={false} (Home mode) never fetches resource lists", async () => {
    const spy = stubLists as never;
    const apps = vi.spyOn(api, "listApps");
    const servers = vi.spyOn(api, "listServers");
    const dbs = vi.spyOn(api, "listDatabases");
    const doms = vi.spyOn(api, "listDomains");
    void spy;
    wrap(<CommandPalette dests={dests} fleet={false} onClose={() => {}} />);
    screen.getByRole("combobox");
    await Promise.resolve();
    expect(apps).not.toHaveBeenCalled();
    expect(servers).not.toHaveBeenCalled();
    expect(dbs).not.toHaveBeenCalled();
    expect(doms).not.toHaveBeenCalled();
  });
});
