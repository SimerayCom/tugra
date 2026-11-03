import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { DatabaseLinksCard } from "./database-links-card";
import { api } from "../lib/api";
import type { Database, DatabaseLinkView } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>{ui}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const db = (over: Partial<Database>): Database => ({ id: "d1", name: "orders", engine: "POSTGRES", serverId: "s1", status: "RUNNING", ...over } as unknown as Database);

describe("DatabaseLinksCard", () => {
  it("lists a link with its env var and no secret, and offers eligible same-server DBs", async () => {
    const links: DatabaseLinkView[] = [{ linkId: "l1", envVar: "DATABASE_URL", databaseId: "d1", name: "orders", engine: "POSTGRES", route: "internal", shadowedBy: null }];
    vi.spyOn(api, "getAppDatabaseLinks").mockResolvedValue(links);
    vi.spyOn(api, "listDatabases").mockResolvedValue([
      db({ id: "d1", name: "orders" }), // already linked -> excluded
      db({ id: "d2", name: "cache", engine: "REDIS" }), // same server, unlinked -> offered
      { id: "d3", name: "elsewhere", engine: "POSTGRES", serverId: "s2", status: "RUNNING" } as unknown as Database, // other server -> excluded
    ]);
    wrap(<DatabaseLinksCard id="a1" serverId="s1" canWrite />);
    expect(await screen.findByText("orders")).toBeTruthy();
    expect(screen.getByText("DATABASE_URL")).toBeTruthy();
    const opts = Array.from(document.querySelectorAll("option")).map((o) => o.textContent);
    expect(opts.some((o) => o?.includes("cache"))).toBe(true);
    expect(opts.some((o) => o?.includes("elsewhere"))).toBe(false); // different server, not eligible
    expect(opts.some((o) => o?.includes("orders"))).toBe(false); // already linked
  });

  it("links the selected database and shows a shadowed badge for an overridden link", async () => {
    vi.spyOn(api, "getAppDatabaseLinks").mockResolvedValue([
      { linkId: "l1", envVar: "DATABASE_URL", databaseId: "d1", name: "orders", engine: "POSTGRES", route: "internal", shadowedBy: "app-env" },
    ]);
    vi.spyOn(api, "listDatabases").mockResolvedValue([db({ id: "d2", name: "cache", engine: "REDIS" })]);
    const link = vi.spyOn(api, "linkAppDatabase").mockResolvedValue({ linkId: "l2", envVar: "REDIS_URL" } as DatabaseLinkView);
    wrap(<DatabaseLinksCard id="a1" serverId="s1" canWrite />);
    await screen.findByText("orders");
    expect(screen.getByText(/overridden/i)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "d2" } });
    fireEvent.click(screen.getByText("Link"));
    await waitFor(() => expect(link).toHaveBeenCalledWith("a1", { databaseId: "d2", envVar: undefined, adoptEnv: undefined }));
  });

  it("hides mutating controls when the viewer can't write", async () => {
    vi.spyOn(api, "getAppDatabaseLinks").mockResolvedValue([{ linkId: "l1", envVar: "DATABASE_URL", name: "orders", databaseId: "d1", route: "internal", shadowedBy: null }]);
    const listDbs = vi.spyOn(api, "listDatabases").mockResolvedValue([]);
    wrap(<DatabaseLinksCard id="a1" serverId="s1" canWrite={false} />);
    await screen.findByText("orders");
    expect(screen.queryByText("Link")).toBeNull();
    expect(listDbs).not.toHaveBeenCalled(); // picker query disabled for read-only viewers
  });

  it("shows a spinner while loading — not the empty state, and no link form yet", () => {
    vi.spyOn(api, "getAppDatabaseLinks").mockReturnValue(new Promise<DatabaseLinkView[]>(() => {})); // never resolves
    vi.spyOn(api, "listDatabases").mockResolvedValue([]);
    wrap(<DatabaseLinksCard id="a1" serverId="s1" canWrite />);
    expect(screen.getByRole("status")).toBeTruthy(); // Spinner
    expect(screen.queryByText(/no databases linked/i)).toBeNull(); // must not claim "empty" mid-load
    expect(screen.queryByText("Link")).toBeNull(); // link form gated off until the query settles
  });

  it("shows an error with retry when the links query fails — never a false 'empty'", async () => {
    const get = vi.spyOn(api, "getAppDatabaseLinks").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "listDatabases").mockResolvedValue([]);
    wrap(<DatabaseLinksCard id="a1" serverId="s1" canWrite />);
    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
    expect(screen.queryByText(/no databases linked/i)).toBeNull(); // a failed fetch is NOT an empty list
    expect(screen.queryByText("Link")).toBeNull(); // link form gated off on error too
    fireEvent.click(screen.getByText(/try again/i));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2)); // retry refetches
  });

  it("does not claim 'no eligible database' while the databases picker query is still loading", async () => {
    vi.spyOn(api, "getAppDatabaseLinks").mockResolvedValue([]); // links loaded (empty)
    vi.spyOn(api, "listDatabases").mockReturnValue(new Promise(() => {})); // picker query hangs
    wrap(<DatabaseLinksCard id="a1" serverId="s1" canWrite />);
    await screen.findByText(/no databases linked/i); // links empty state
    expect(screen.queryByText(/no eligible database/i)).toBeNull(); // must not pre-judge the picker
    expect(screen.getByRole("status")).toBeTruthy(); // picker spinner
  });

  it("offers a retry (not 'no eligible database') when the databases picker query fails", async () => {
    vi.spyOn(api, "getAppDatabaseLinks").mockResolvedValue([]);
    const listDbs = vi.spyOn(api, "listDatabases").mockRejectedValue(new Error("boom"));
    wrap(<DatabaseLinksCard id="a1" serverId="s1" canWrite />);
    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
    expect(screen.queryByText(/no eligible database/i)).toBeNull();
    fireEvent.click(screen.getByText(/try again/i));
    await waitFor(() => expect(listDbs).toHaveBeenCalledTimes(2));
  });
});
