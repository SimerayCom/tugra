import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { TileActionsSheet } from "./tile-actions-sheet";
import { api } from "../lib/api";
import { filesApi, type FilesMeta } from "../lib/files-api";
import type { LauncherTile } from "../lib/launcher";

afterEach(cleanup);
let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
});
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
const tile = (over: Partial<LauncherTile> = {}): LauncherTile =>
  ({ id: "a1", name: "Ghost", url: "https://g.io", status: "RUNNING", phase: "running", linkKind: "domain", source: "IMAGE", templateSlug: "ghost", templateLogo: null, iconUpdatedAt: null, exposeMode: "magic", domain: "g.io", tunnelExposed: false, canWrite: true, teamId: "t1", projectId: null, projectName: null, serverId: "s1", ...over });

const meta: FilesMeta = {
  serverOnline: true, clustered: false, capabilities: { files: true, filesWrite: true, terminal: false }, canTerminal: false,
  agentSupportsFs2: true, datastore: false, volumes: [{ name: "data", writable: true }],
  container: { available: false, writable: false, reason: "permission", names: [] },
  limits: { maxUploadBytes: 1000, maxDownloadBytes: 1000, maxEditBytes: 1000 },
};
const stubFiles = () => {
  vi.spyOn(api, "getApp").mockResolvedValue({ volumes: [{ name: "data", path: "/data" }], serverId: "s7" } as never);
  vi.spyOn(api, "listAppFiles").mockResolvedValue({ entries: [{ name: "config.yml", type: "file", size: 10, mode: "rw-r--r--", mtime: 1 }], truncated: false });
  return vi.spyOn(filesApi, "filesMeta").mockResolvedValue(meta);
};

describe("TileActionsSheet files view (Home launcher)", () => {
  it("a writer's inline file browser gets the write UI (meta is consulted for the same app)", async () => {
    const m = stubFiles();
    wrap(<TileActionsSheet tile={tile({ canWrite: true })} onClose={vi.fn()} onExpose={vi.fn()} />);
    fireEvent.click(screen.getByText("Files"));
    expect(await screen.findByRole("button", { name: "Upload" })).toBeTruthy();
    expect(m).toHaveBeenCalledWith("a1");
  });

  it("a non-writer is never offered Files, so no meta call and no write controls can appear", async () => {
    const m = stubFiles();
    wrap(<TileActionsSheet tile={tile({ canWrite: false })} onClose={vi.fn()} onExpose={vi.fn()} />);
    expect(screen.queryByText("Files")).toBeNull();
    expect(m).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
  });
});
