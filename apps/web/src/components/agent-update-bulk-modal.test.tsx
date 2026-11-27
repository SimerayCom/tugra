import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { AgentUpdateBulkModal } from "./agent-update-bulk-modal";
import { api } from "../lib/api";
import type { AgentUpdateResponse, InFlightItem, ServerView } from "../lib/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RUN: InFlightItem = { kind: "migration-run", id: "run1", label: "coolify.example.com", serverIds: ["a"], teamId: "t1", since: new Date().toISOString() };
const server = (id: string, name: string) => ({ id, name, canWrite: true, teamId: "t1" }) as unknown as ServerView;
const servers = [server("a", "edge-a"), server("b", "edge-b")];
const res = (over: Partial<AgentUpdateResponse>): AgentUpdateResponse => ({ status: "ok", total: 2, sent: 0, offline: 0, skipped: 0, held: 0, results: [], ...over });

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <I18nProvider>
        <AgentUpdateBulkModal servers={servers} selectedIds={["a", "b"]} onClose={() => undefined} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("AgentUpdateBulkModal with work in flight", () => {
  it("updates the free server, lists the held one with what is running, and says so", async () => {
    vi.spyOn(api, "bulkUpdateAgent").mockResolvedValue(
      res({ sent: 1, held: 1, results: [{ serverId: "a", status: "held", reason: "migration-active", inFlight: [RUN] }, { serverId: "b", status: "sent" }] }),
    );
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: "Update agent" }));
    await screen.findByText(/1 held while work runs on the server/);
    expect(screen.getByText("Held: work is running")).toBeTruthy();
    expect(screen.getByText("Dispatched")).toBeTruthy();
    expect(screen.getByTestId("agent-update-held").textContent).toContain("Held: 1 migration in progress");
    expect(screen.getByTestId("agent-update-held").textContent).toContain("coolify.example.com");
    expect(api.bulkUpdateAgent).toHaveBeenCalledWith(["a", "b"]);
  });

  it("'Update held servers anyway' asks first, then sends only the held ones with force and merges the results", async () => {
    const bulk = vi
      .spyOn(api, "bulkUpdateAgent")
      .mockResolvedValueOnce(res({ sent: 1, held: 1, results: [{ serverId: "a", status: "held", reason: "migration-active", inFlight: [RUN] }, { serverId: "b", status: "sent" }] }))
      .mockResolvedValueOnce(res({ total: 1, sent: 1, results: [{ serverId: "a", status: "sent" }] }));
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: "Update agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update held servers anyway" }));
    const confirm = screen.getByTestId("agent-update-force-confirm");
    expect(confirm.textContent).toContain("may need to be resumed or rolled back");
    expect(bulk).toHaveBeenCalledTimes(1); // nothing forced until confirmed
    fireEvent.click(within(confirm).getByRole("button", { name: "Update anyway" }));
    await waitFor(() => expect(bulk).toHaveBeenCalledWith(["a"], true));
    await waitFor(() => expect(screen.queryByTestId("agent-update-held")).toBeNull());
    expect(screen.getAllByText("Dispatched")).toHaveLength(2);
  });

  it("Wait on the confirm step sends nothing", async () => {
    const bulk = vi.spyOn(api, "bulkUpdateAgent").mockResolvedValue(res({ held: 1, results: [{ serverId: "a", status: "held", reason: "migration-active", inFlight: [RUN] }] }));
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: "Update agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update held servers anyway" }));
    fireEvent.click(within(screen.getByTestId("agent-update-force-confirm")).getByRole("button", { name: "Wait" }));
    expect(screen.queryByTestId("agent-update-force-confirm")).toBeNull();
    expect(bulk).toHaveBeenCalledTimes(1);
  });

  it("does not offer force when the caller may not force any of the held servers", async () => {
    vi.spyOn(api, "bulkUpdateAgent").mockResolvedValue(res({ held: 1, results: [{ serverId: "a", status: "held", reason: "force-not-permitted", inFlight: [RUN] }] }));
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: "Update agent" }));
    await screen.findByText("Held: only a team owner or admin can update through running work");
    expect(screen.queryByRole("button", { name: "Update held servers anyway" })).toBeNull();
  });
});
