import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { ToastProvider } from "../../../../components/toast";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "c1" }), useRouter: () => ({ replace: vi.fn() }) }));

import ClusterDetailPage from "./page";
import { api } from "../../../../lib/api";

const DETAIL = {
  id: "c1", teamId: "t1", name: "eu-west", description: "prod", nodeCount: 2, canWrite: true, createdAt: "2026-01-01",
  servers: [
    { id: "s1", name: "node-a", status: "ONLINE", hostname: null, publicIp: "1.1.1.1" },
    { id: "s2", name: "node-b", status: "OFFLINE", hostname: null, publicIp: null },
  ],
  health: { nodes: { online: 1, offline: 1, pending: 0, total: 2 }, apps: { running: 3, stopped: 0, failed: 0, new: 0, total: 3 } },
};

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("ClusterDetailPage", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(api, "getCluster").mockResolvedValue(DETAIL as never);
    vi.spyOn(api, "listServers").mockResolvedValue([
      { id: "s1", name: "node-a", status: "ONLINE", teamId: "t1", tags: [] },
      { id: "s2", name: "node-b", status: "OFFLINE", teamId: "t1", tags: [] },
      { id: "s3", name: "node-c", status: "ONLINE", teamId: "t1", tags: [] },
    ] as never);
    // Default: no swarm formed (keeps the existing tests unaffected; add-node tests override this).
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue({ clusterId: "c1", swarmStatus: "NONE", managerServerId: null, swarmLastError: null, nodes: [], live: null } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders the cluster name, health rollup and members", async () => {
    wrap(<ClusterDetailPage />);
    expect(await screen.findByText("eu-west")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy(); // nodes online/total
    expect(screen.getByText("3/3")).toBeTruthy(); // apps running/total
    expect(screen.getByText("node-a")).toBeTruthy();
    expect(screen.getByText("1 offline")).toBeTruthy();
  });

  it("manages membership → setClusterServers with the checked servers", async () => {
    const setSpy = vi.spyOn(api, "setClusterServers").mockResolvedValue(DETAIL as never);
    wrap(<ClusterDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage servers" }));
    // Add node-c (currently unchecked); s1/s2 already members.
    const cCheckbox = (await screen.findByText("node-c")).closest("label")!.querySelector("input")!;
    fireEvent.click(cCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("c1", expect.arrayContaining(["s1", "s2", "s3"])));
  });

  const ACTIVE_SWARM = (nodes: unknown[]) =>
    ({ clusterId: "c1", swarmStatus: "ACTIVE", managerServerId: "s1", swarmLastError: null, nodes, live: null }) as never;

  it("shows 'Add node' on an ACTIVE swarm with an online, not-yet-joined member and joins it", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(
      ACTIVE_SWARM([
        { serverId: "s1", name: "node-a", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
        { serverId: "s3", name: "node-c", status: "ONLINE", swarmRole: null, swarmError: null, swarmCapable: true },
      ]),
    );
    const joinSpy = vi.spyOn(api, "joinSwarmNode").mockResolvedValue(ACTIVE_SWARM([]));
    wrap(<ClusterDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add node" }));
    // Modal open: the submit button is the last "Add node" button (card button + modal submit both match).
    const addButtons = await screen.findAllByRole("button", { name: "Add node" });
    fireEvent.click(addButtons[addButtons.length - 1]);
    await waitFor(() => expect(joinSpy).toHaveBeenCalledWith("c1", { serverId: "s3" }));
  });

  it("hides 'Add node' when the ACTIVE swarm has no eligible candidate", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(
      ACTIVE_SWARM([
        { serverId: "s1", name: "node-a", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
        { serverId: "s2", name: "node-b", status: "ONLINE", swarmRole: "WORKER", swarmError: null, swarmCapable: true },
      ]),
    );
    wrap(<ClusterDetailPage />);
    await screen.findByRole("button", { name: "Dissolve swarm" }); // swarm card rendered
    expect(screen.queryByRole("button", { name: "Add node" })).toBeNull();
  });

  it("hides 'Add node' for an online, unjoined member that lacks the swarm capability", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(
      ACTIVE_SWARM([
        { serverId: "s1", name: "node-a", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
        { serverId: "s3", name: "node-c", status: "ONLINE", swarmRole: null, swarmError: null, swarmCapable: false },
      ]),
    );
    wrap(<ClusterDetailPage />);
    await screen.findByRole("button", { name: "Dissolve swarm" });
    expect(screen.queryByRole("button", { name: "Add node" })).toBeNull();
  });

  it("renders a node's label editor when a live node matches its swarmNodeId", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue({
      clusterId: "c1", swarmStatus: "ACTIVE", managerServerId: "s1", swarmLastError: null,
      nodes: [{ serverId: "s1", name: "node-a", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true, swarmNodeId: "nd1" }],
      live: [{ id: "nd1", hostname: "node-a", role: "manager", state: "ready", availability: "active", labels: { zone: "east" } }],
    } as never);
    wrap(<ClusterDetailPage />);
    await waitFor(() => expect(screen.getByText("zone=east")).toBeTruthy());
  });
});
