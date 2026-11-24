import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { AgentFleetNotice } from "./agent-fleet-notice";
import { api } from "../lib/api";
import type { AgentFleetStatus, AgentUpdateResponse } from "../lib/types";

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
  ...over,
});
const res = (over: Partial<AgentUpdateResponse> = {}): AgentUpdateResponse => ({ status: "ok", total: 3, sent: 3, offline: 0, skipped: 0, results: [], ...over });

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <AgentFleetNotice />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("AgentFleetNotice", () => {
  it("says how many agents are behind and offers one click to update them all", async () => {
    vi.spyOn(api, "getAgentFleetStatus").mockResolvedValue(status());
    renderIt();
    expect(await screen.findByText("3/24 agents are on an older version")).toBeTruthy();
    expect(screen.getByText("Update them all in one click.")).toBeTruthy();
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
});
