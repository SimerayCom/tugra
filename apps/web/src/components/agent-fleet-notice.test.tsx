import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { AgentFleetNotice } from "./agent-fleet-notice";
import { ConfirmProvider } from "./confirm";
import { api } from "../lib/api";
import type { AgentFleetStatus, AgentUpdateResponse, InFlightItem } from "../lib/types";

const RUN: InFlightItem = { kind: "migration-run", id: "run1", label: "coolify.example.com", serverIds: ["a"], teamId: "t1", since: new Date().toISOString() };

const toast = vi.hoisted(() => vi.fn());
vi.mock("./toast", () => ({ useToast: () => toast }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.mockClear();
});

const status = (over: Partial<AgentFleetStatus> = {}): AgentFleetStatus => ({
  current: "0.2.0",
  total: 24,
  outdated: 3,
  outdatedServerIds: ["a", "b", "c"],
  autoUpdate: false,
  hubBehind: false,
  held: [],
  ...over,
});
const res = (over: Partial<AgentUpdateResponse> = {}): AgentUpdateResponse => ({ status: "ok", total: 3, sent: 3, offline: 0, skipped: 0, held: 0, results: [], ...over });

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <ConfirmProvider>
          <AgentFleetNotice />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("AgentFleetNotice", () => {
  it("says how many agents are behind and offers one click to update them all", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status());
    renderIt();
    expect(await screen.findByText("3/24 agents are on an older version")).toBeTruthy();
    expect(screen.getByText("Update them all in one click, or turn on automatic updates and the hub keeps every agent current.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Turn on automatic updates/ }).getAttribute("href")).toBe("/settings?tab=instance&section=backups#updates");
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("tells the owner the hub is already rolling them out when automatic updates are on", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status({ autoUpdate: true }));
    renderIt();
    expect(await screen.findByText("They are updating one by one.")).toBeTruthy();
  });

  it("does not claim the agents are updating while the hub itself is still behind", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status({ autoUpdate: true, hubBehind: true }));
    renderIt();
    expect(await screen.findByText("The hub updates first, then the agents follow.")).toBeTruthy();
    expect(screen.queryByText("They are updating one by one.")).toBeNull();
  });

  it("renders nothing when every agent is current (or the status is unavailable)", async () => {
    const spy = vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status({ outdated: 0, outdatedServerIds: [] }));
    const { container } = renderIt();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    cleanup();
    vi.spyOn(api, "getAgentFleetStatus").mockRejectedValue(new Error("403"));
    const second = renderIt();
    await waitFor(() => expect(second.container.textContent).toBe(""));
  });

  it("Update all calls the hub once and confirms how many agents were sent the update", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status());
    const upd = vi.spyOn(api, "updateOutdatedAgents").mockResolvedValue(res());
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(upd).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Update sent to 3 agents", "success"));
  });

  it("explains when the hub itself must be updated first", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status());
    vi.spyOn(api, "updateOutdatedAgents").mockResolvedValue(res({ status: "hub-behind", total: 0, sent: 0 }));
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Update the hub first. Agents never run ahead of it.", "info"));
  });

  it("says so when nothing could be sent (all offline or refused)", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status());
    vi.spyOn(api, "updateOutdatedAgents").mockResolvedValue(res({ sent: 0, offline: 3 }));
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Nothing could be updated right now.", "info"));
  });

  it("lists the servers held while work runs on them, with what is running", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status({ held: [{ serverId: "a", inFlight: [RUN] }, { serverId: "zzz-not-behind", inFlight: [RUN] }] }));
    renderIt();
    const held = await screen.findByTestId("agent-fleet-held");
    expect(held.textContent).toContain("1 held while work runs on the server. They are updated once it ends.");
    expect(held.textContent).toContain("coolify.example.com");
  });

  it("shows no held line when no behind server is busy", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status({ held: [{ serverId: "zzz-not-behind", inFlight: [RUN] }] }));
    renderIt();
    await screen.findByText("3/24 agents are on an older version");
    expect(screen.queryByTestId("agent-fleet-held")).toBeNull();
  });

  it("Update all: the free servers are updated, the held one is reported, and 'Update anyway' sends just that one with force", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status());
    vi.spyOn(api, "updateOutdatedAgents").mockResolvedValue(
      res({ total: 3, sent: 2, held: 1, results: [{ serverId: "a", status: "held", reason: "migration-active", inFlight: [RUN] }, { serverId: "b", status: "sent" }, { serverId: "c", status: "sent" }] }),
    );
    const forced = vi.spyOn(api, "bulkUpdateAgent").mockResolvedValue(res({ total: 1, sent: 1, results: [{ serverId: "a", status: "sent" }] }));
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("1 of the agents are held because work is running on their server.");
    expect(dialog.textContent).toContain("Migration: coolify.example.com");
    expect(dialog.textContent).toContain("may need to be resumed or rolled back");
    fireEvent.click(screen.getByRole("button", { name: "Update anyway" }));
    await waitFor(() => expect(forced).toHaveBeenCalledWith(["a"], true));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Update sent to 3 agents", "success"));
  });

  it("Update all: Wait leaves the held server alone and no force call is made", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status());
    vi.spyOn(api, "updateOutdatedAgents").mockResolvedValue(
      res({ total: 1, sent: 0, held: 1, results: [{ serverId: "a", status: "held", reason: "migration-active", inFlight: [RUN] }] }),
    );
    const forced = vi.spyOn(api, "bulkUpdateAgent");
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Wait" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("1 held while work runs on the server", "info"));
    expect(forced).not.toHaveBeenCalled();
  });

  it("Update all: a server held for a member who may not force is reported, not offered", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status());
    vi.spyOn(api, "updateOutdatedAgents").mockResolvedValue(
      res({ total: 1, sent: 0, held: 1, results: [{ serverId: "a", status: "held", reason: "force-not-permitted", inFlight: [RUN] }] }),
    );
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Update all" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("1 held while work runs on the server", "info"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
