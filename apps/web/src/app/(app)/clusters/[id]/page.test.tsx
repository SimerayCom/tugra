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
    // Benign default so the ingress query doesn't hit the network in swarm-active tests.
    vi.spyOn(api, "getIngress").mockResolvedValue({ replicas: 1, nodes: [] } as never);
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

  // ── multi-manager Raft HA ──
  const QUORUM_SWARM = (nodes: unknown[], quorum: unknown, managerServerId = "s1") =>
    ({ clusterId: "c1", swarmStatus: "ACTIVE", managerServerId, swarmLastError: null, nodes, live: null, quorum }) as never;

  it("renders the quorum-lost banner when a majority of managers are offline", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(
      QUORUM_SWARM(
        [
          { serverId: "s1", name: "node-a", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
          { serverId: "s2", name: "node-b", status: "OFFLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
          { serverId: "s3", name: "node-c", status: "OFFLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
        ],
        { managers: 3, managersOnline: 1, hasQuorum: false },
      ),
    );
    wrap(<ClusterDetailPage />);
    expect(await screen.findByText(/Quorum lost/i)).toBeTruthy();
  });

  it("Advanced → Add manager modal submit calls api.addManager", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(
      QUORUM_SWARM(
        [
          { serverId: "s1", name: "node-a", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
          { serverId: "s2", name: "node-b", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
          { serverId: "s3", name: "node-c", status: "ONLINE", swarmRole: "WORKER", swarmError: null, swarmCapable: true },
        ],
        { managers: 2, managersOnline: 2, hasQuorum: true },
      ),
    );
    const addSpy = vi.spyOn(api, "addManager").mockResolvedValue(QUORUM_SWARM([], { managers: 3, managersOnline: 3, hasQuorum: true }));
    wrap(<ClusterDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Advanced/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add manager" }));
    // The modal's submit button is the last "Add manager" (the Advanced-revealed card button matches too).
    const addButtons = await screen.findAllByRole("button", { name: "Add manager" });
    fireEvent.click(addButtons[addButtons.length - 1]);
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith("c1", { serverId: "s3", acknowledgeEvenQuorum: undefined }));
  });

  it("Demote on a non-primary manager row (after confirm) calls api.removeManager; the primary has no Demote", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(
      QUORUM_SWARM(
        [
          { serverId: "s1", name: "node-a", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
          { serverId: "s2", name: "node-b", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
        ],
        { managers: 2, managersOnline: 2, hasQuorum: true },
      ),
    );
    const rmSpy = vi.spyOn(api, "removeManager").mockResolvedValue(QUORUM_SWARM([], { managers: 1, managersOnline: 1, hasQuorum: true }));
    wrap(<ClusterDetailPage />);
    // Exactly ONE Demote button — the non-primary manager (s2). The primary (s1) shows none.
    const demoteButtons = await screen.findAllByRole("button", { name: "Demote" });
    expect(demoteButtons.length).toBe(1);
    fireEvent.click(demoteButtons[0]);
    // Confirm dialog → click Confirm.
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(rmSpy).toHaveBeenCalledWith("c1", "s2"));
  });

  it("Demote even-quorum guard → acknowledge-and-retry re-submits with acknowledgeEvenQuorum (F6)", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(
      QUORUM_SWARM(
        [
          { serverId: "s1", name: "node-a", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
          { serverId: "s2", name: "node-b", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
          { serverId: "s3", name: "node-c", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true },
        ],
        { managers: 3, managersOnline: 3, hasQuorum: true },
      ),
    );
    const rmSpy = vi.spyOn(api, "removeManager")
      .mockRejectedValueOnce(new Error("removing this manager brings the total to 2 — an even manager count adds no extra Raft fault-tolerance"))
      .mockResolvedValueOnce(QUORUM_SWARM([], { managers: 2, managersOnline: 2, hasQuorum: true }));
    wrap(<ClusterDetailPage />);
    // 2 non-primary managers (s2, s3) → 2 Demote buttons; demote the first (s2).
    const demoteButtons = await screen.findAllByRole("button", { name: "Demote" });
    expect(demoteButtons.length).toBe(2);
    fireEvent.click(demoteButtons[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" })); // demote confirm
    await waitFor(() => expect(rmSpy).toHaveBeenNthCalledWith(1, "c1", "s2")); // first attempt, no ack → 400
    // even-quorum error → acknowledge-and-retry dialog → "Proceed anyway"
    fireEvent.click(await screen.findByRole("button", { name: "Proceed anyway" }));
    await waitFor(() => expect(rmSpy).toHaveBeenNthCalledWith(2, "c1", "s2", { acknowledgeEvenQuorum: true }));
  });

  // ── ingress HA ──
  const oneManager = () => [{ serverId: "s1", name: "node-a", status: "ONLINE", swarmRole: "MANAGER", swarmError: null, swarmCapable: true }];

  it("renders the Ingress panel with node IPs and the DNS-pointing hint", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(ACTIVE_SWARM(oneManager()));
    vi.spyOn(api, "getIngress").mockResolvedValue({ replicas: 2, nodes: [{ id: "s1", name: "node-a", ip: "1.1.1.1" }, { id: "s3", name: "node-c", ip: "3.3.3.3" }] } as never);
    wrap(<ClusterDetailPage />);
    expect(await screen.findByText("Ingress (HTTPS)")).toBeTruthy();
    expect(await screen.findByText("3.3.3.3")).toBeTruthy();
    expect(screen.getByText(/point one DNS A record/i)).toBeTruthy();
  });

  it("selecting a replica count calls api.setIngressReplicas", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(ACTIVE_SWARM(oneManager()));
    vi.spyOn(api, "getIngress").mockResolvedValue({ replicas: 1, nodes: [{ id: "s1", name: "node-a", ip: "1.1.1.1" }] } as never);
    const setSpy = vi.spyOn(api, "setIngressReplicas").mockResolvedValue({ replicas: 2, nodes: [] } as never);
    wrap(<ClusterDetailPage />);
    await screen.findByText("Ingress (HTTPS)");
    fireEvent.click(screen.getByRole("button", { name: "2" })); // the "2 replicas" button
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith("c1", 2));
  });

  it("surfaces the DNS-01-required error when raising replicas is refused", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(ACTIVE_SWARM(oneManager()));
    vi.spyOn(api, "getIngress").mockResolvedValue({ replicas: 1, nodes: [{ id: "s1", name: "node-a", ip: "1.1.1.1" }] } as never);
    vi.spyOn(api, "setIngressReplicas").mockRejectedValue(new Error("ingress HA (2+ replicas) requires DNS-01"));
    wrap(<ClusterDetailPage />);
    await screen.findByText("Ingress (HTTPS)");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(await screen.findByText(/DNS-01/i)).toBeTruthy();
  });
});
