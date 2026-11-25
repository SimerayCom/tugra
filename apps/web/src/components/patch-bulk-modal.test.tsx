import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { PatchBulkModal } from "./patch-bulk-modal";
import { ConfirmProvider } from "./confirm";
import { api } from "../lib/api";
import type { ServerView } from "../lib/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PatchBulkModal", () => {
  it("reminds that reboots are manual once an apply has finished", async () => {
    vi.spyOn(api, "bulkUpgradeAll").mockResolvedValue({ results: [{ serverId: "s1", online: true, exitCode: 0 }], skipped: [] });
    const servers = [{ id: "s1", name: "box", teamId: "t1", canWrite: true }] as unknown as ServerView[];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <ConfirmProvider>
            <PatchBulkModal servers={servers} selectedIds={["s1"]} onClose={() => {}} />
          </ConfirmProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply updates" }));
    await waitFor(() => expect(screen.getByRole("note")).toHaveTextContent("Reboots are never automatic"));
  });

  const servers = [{ id: "s1", name: "box", teamId: "t1", canWrite: true }] as unknown as ServerView[];
  const mount = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <ConfirmProvider>
            <PatchBulkModal servers={servers} selectedIds={["s1"]} onClose={() => {}} />
          </ConfirmProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );

  it("keeps apps running by default: the fleet apply leaves the container engine out, no confirmation", async () => {
    const spy = vi.spyOn(api, "bulkUpgradeAll").mockResolvedValue({ results: [{ serverId: "s1", online: true, exitCode: 0 }], skipped: [] });
    mount();
    expect(screen.getByRole("checkbox", { name: /Keep apps running/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Apply updates" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(["s1"], "except-engine"));
    expect(screen.queryByText(/Docker restarts on 1 server/)).toBeNull();
  });

  it("unticking it warns, and the apply is confirmed before it updates the engine too", async () => {
    const spy = vi.spyOn(api, "bulkUpgradeAll").mockResolvedValue({ results: [{ serverId: "s1", online: true, exitCode: 0 }], skipped: [] });
    mount();
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep apps running/ }));
    expect(screen.getByText(/Docker restarts on every selected server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply updates" }));
    expect(await screen.findByText(/Docker restarts on 1 server\(s\), so every app/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/Docker restarts on 1 server\(s\), so every app/)).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update and restart apps" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(["s1"], "all"));
  });

  it("never runs the restart-everything update without a confirm provider", () => {
    // useConfirm throws without a provider, so the modal cannot be mounted unguarded: the unconfirmed path does not exist.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <I18nProvider>
            <PatchBulkModal servers={servers} selectedIds={["s1"]} onClose={() => {}} />
          </I18nProvider>
        </QueryClientProvider>,
      ),
    ).toThrow(/ConfirmProvider/);
    err.mockRestore();
  });

  it("tells that a half-configured engine is refused in keep-apps mode, and shows a failed server's reason", async () => {
    vi.spyOn(api, "bulkUpgradeAll").mockResolvedValue({ results: [{ serverId: "s1", online: true, error: "dpkg left docker-ce half-configured" }], skipped: [] });
    mount();
    expect(screen.getByText(/half-configured is refused in this mode/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply updates" }));
    expect(await screen.findByTestId("patch-row-error")).toHaveTextContent("dpkg left docker-ce half-configured");
  });
});
