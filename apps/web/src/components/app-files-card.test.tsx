import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { AppFilesCard } from "./app-files-card";
import { api, ApiError } from "../lib/api";
import type { AppVolume, FileListing } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
});
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const VOL: AppVolume[] = [{ name: "data", path: "/data" }];
const listing = (over: Partial<FileListing> = {}): FileListing => ({
  entries: [
    { name: "readme.txt", type: "file", size: 2048, mode: "rw-r--r--", mtime: 1 },
    { name: "sub", type: "dir", size: 0, mode: "rwxr-xr-x", mtime: 2 },
  ],
  truncated: false,
  ...over,
});

describe("AppFilesCard", () => {
  it("lists entries (directories first) for the first volume", async () => {
    const spy = vi.spyOn(api, "listAppFiles").mockResolvedValue(listing());
    wrap(<AppFilesCard id="a1" volumes={VOL} />);
    expect(await screen.findByText("sub")).toBeTruthy();
    expect(screen.getByText("readme.txt")).toBeTruthy();
    expect(spy).toHaveBeenCalledWith("a1", "data", "");
    // directory is rendered before the file (dirs-first sort)
    const names = screen.getAllByText(/^(sub|readme\.txt)$/).map((n) => n.textContent);
    expect(names).toEqual(["sub", "readme.txt"]);
  });

  it("descends into a directory (re-queries with the new path) and shows a breadcrumb", async () => {
    const spy = vi.spyOn(api, "listAppFiles").mockResolvedValue(listing());
    wrap(<AppFilesCard id="a1" volumes={VOL} />);
    fireEvent.click(await screen.findByText("sub"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("a1", "data", "sub"));
    // breadcrumb shows the volume root as a way back up
    expect(screen.getByRole("button", { name: "data" })).toBeTruthy();
  });

  it("warns when the listing is truncated", async () => {
    vi.spyOn(api, "listAppFiles").mockResolvedValue(listing({ truncated: true }));
    wrap(<AppFilesCard id="a1" volumes={VOL} />);
    expect(await screen.findByText(/this folder has more/i)).toBeTruthy();
  });

  it("surfaces an API error (e.g. agent offline / capability not granted)", async () => {
    vi.spyOn(api, "listAppFiles").mockRejectedValue(new ApiError(503, "agent offline"));
    wrap(<AppFilesCard id="a1" volumes={VOL} />);
    expect(await screen.findByText("agent offline")).toBeTruthy();
  });

  it("shows an empty state when the app declares no volumes (no fetch)", () => {
    const spy = vi.spyOn(api, "listAppFiles");
    wrap(<AppFilesCard id="a1" volumes={[]} />);
    expect(screen.getByText(/doesn't declare any persistent volumes/i)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("exposes breadcrumb + volume-picker accessibility semantics (nav/aria-current/aria-pressed)", async () => {
    vi.spyOn(api, "listAppFiles").mockResolvedValue(listing());
    wrap(<AppFilesCard id="a1" volumes={[{ name: "data", path: "/data" }, { name: "cache", path: "/cache" }]} />);
    await screen.findByText("sub");
    // Breadcrumb is a labelled <nav>; the active (root) crumb is aria-current and NOT `disabled`
    // (so keyboard focus can land on it after navigation).
    const nav = screen.getByRole("navigation", { name: "File path" });
    const rootCrumb = within(nav).getByRole("button", { name: "data" });
    expect(rootCrumb.getAttribute("aria-current")).toBe("page");
    expect(rootCrumb.hasAttribute("disabled")).toBe(false);
    // The selected volume button is aria-pressed.
    const group = screen.getByRole("group", { name: "Volume" });
    expect(within(group).getByRole("button", { name: "data" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "cache" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("offers a volume picker when there is more than one volume and switches to the root on change", async () => {
    const spy = vi.spyOn(api, "listAppFiles").mockResolvedValue(listing());
    wrap(<AppFilesCard id="a1" volumes={[{ name: "data", path: "/data" }, { name: "cache", path: "/cache" }]} />);
    await screen.findByText("sub");
    fireEvent.click(screen.getByRole("button", { name: "cache" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("a1", "cache", ""));
  });
});
