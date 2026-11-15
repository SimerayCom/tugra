import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { PatchBulkModal } from "./patch-bulk-modal";
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
          <PatchBulkModal servers={servers} selectedIds={["s1"]} onClose={() => {}} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply updates" }));
    await waitFor(() => expect(screen.getByRole("note")).toHaveTextContent("Reboots are never automatic"));
  });
});
