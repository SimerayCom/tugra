import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { CapabilitiesBulkModal } from "./capabilities-bulk-modal";
import { api } from "../lib/api";
import type { ServerView } from "../lib/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const servers = [
  { id: "s1", name: "app-1", teamId: "t1", canWrite: true, capabilities: ["deploy"] },
  { id: "s2", name: "app-2", teamId: "t1", canWrite: true, capabilities: ["deploy", "terminal"] },
  { id: "s3", name: "app-3", teamId: "t1", canWrite: false, capabilities: ["deploy"] },
] as unknown as ServerView[];

const open = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <CapabilitiesBulkModal servers={servers} selectedIds={["s1", "s2", "s3"]} onClose={() => {}} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("CapabilitiesBulkModal", () => {
  it("lists exactly what changes per server before confirming, and sends only the servers that change", async () => {
    const spy = vi.spyOn(api, "bulkSetServerCapabilities").mockResolvedValue({
      results: [{ id: "s1", ok: true, capabilities: ["deploy", "terminal"], granted: ["terminal"], revoked: [] }],
    });
    open();
    const confirm = screen.getByRole("button", { name: /Turn on for 0/ });
    expect(confirm).toBeDisabled(); // nothing picked yet

    fireEvent.click(screen.getByLabelText(/Terminal/));
    const rows = screen.getAllByTestId("bulk-cap-row").map((r) => r.textContent);
    expect(rows).toEqual(["app-1Terminal", "app-2No change", "app-3Read-only, skipped"]);

    fireEvent.click(screen.getByRole("button", { name: "Turn on for 1" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(["s1"], ["terminal"], []));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 done · 0 failed"));
  });

  it("revoking sends the revoke list; granting file changes also picks Files", async () => {
    const spy = vi.spyOn(api, "bulkSetServerCapabilities").mockResolvedValue({ results: [] });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    fireEvent.click(screen.getByLabelText(/Terminal/));
    fireEvent.click(screen.getByRole("button", { name: "Turn off for 1" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(["s2"], [], ["terminal"]));
  });

  it("granting File changes ticks Files too", () => {
    open();
    fireEvent.click(screen.getByLabelText(/File changes/));
    expect((screen.getByLabelText(/^Files/) as HTMLInputElement).checked).toBe(true);
    const review = screen.getByRole("region", { name: "What will change" });
    expect(within(review).getAllByTestId("bulk-cap-row")[0]).toHaveTextContent("Files, File changes");
  });

  it("shows per-server failures from the hub", async () => {
    vi.spyOn(api, "bulkSetServerCapabilities").mockResolvedValue({
      results: [{ id: "s1", ok: false, error: "forbidden" }],
    });
    open();
    fireEvent.click(screen.getByLabelText(/Terminal/));
    fireEvent.click(screen.getByRole("button", { name: "Turn on for 1" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 done · 1 failed"));
    expect(screen.getByText("You cannot manage this server")).toBeInTheDocument();
  });
});
