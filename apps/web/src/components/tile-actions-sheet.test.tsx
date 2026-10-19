import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { TileActionsSheet } from "./tile-actions-sheet";
import { api } from "../lib/api";
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
  ({ id: "a1", name: "Ghost", url: "https://g.io", status: "RUNNING", phase: "running", linkKind: "domain", source: "IMAGE", templateSlug: "ghost", templateLogo: null, exposeMode: "magic", domain: "g.io", tunnelExposed: false, canWrite: true, ...over });

describe("TileActionsSheet", () => {
  it("offers Logs + Update for a running, writable app; Logs opens an inline log view", async () => {
    vi.spyOn(api, "getAppLogs").mockResolvedValue({ output: "line-1\nline-2" });
    wrap(<TileActionsSheet tile={tile()} onClose={vi.fn()} onExpose={vi.fn()} />);
    expect(screen.getByText("Update")).toBeTruthy();
    fireEvent.click(screen.getByText("Logs"));
    expect(await screen.findByText(/line-1/)).toBeTruthy();
    expect(api.getAppLogs).toHaveBeenCalledWith("a1", 200);
    // Back returns to the action list
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Update")).toBeTruthy();
  });

  it("Update redeploys via the deploy endpoint", async () => {
    const deploy = vi.spyOn(api, "deployApp").mockResolvedValue({} as never);
    wrap(<TileActionsSheet tile={tile()} onClose={vi.fn()} onExpose={vi.fn()} />);
    fireEvent.click(screen.getByText("Update"));
    await waitFor(() => expect(deploy).toHaveBeenCalledWith("a1"));
  });

  it("hides Logs/Update (write actions) from a viewer — only Open", () => {
    wrap(<TileActionsSheet tile={tile({ canWrite: false })} onClose={vi.fn()} onExpose={vi.fn()} />);
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.queryByText("Logs")).toBeNull();
    expect(screen.queryByText("Update")).toBeNull();
  });

  it("offers Pin/Unpin when onTogglePin is wired, and toggles + closes on click", () => {
    const onTogglePin = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ConfirmProvider>
            <TileActionsSheet tile={tile()} pinned={false} onTogglePin={onTogglePin} onClose={onClose} onExpose={vi.fn()} />
          </ConfirmProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("Pin to top"));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ConfirmProvider>
            <TileActionsSheet tile={tile()} pinned onTogglePin={onTogglePin} onClose={onClose} onExpose={vi.fn()} />
          </ConfirmProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText("Unpin")).toBeTruthy();
  });
});
