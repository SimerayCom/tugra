import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ClusterDeployCard } from "./cluster-deploy-card";
import { api } from "../lib/api";
import type { Cluster, ClusterDetail, AppClusterStatus } from "../lib/types";

afterEach(cleanup);

function cluster(over: Partial<Cluster> = {}): Cluster {
  return { id: "c1", teamId: "t1", name: "prod-eu", description: null, nodeCount: 3, swarmStatus: "ACTIVE", canWrite: true, createdAt: "2026-01-01", ...over };
}
function detail(over: Partial<ClusterDetail> = {}): ClusterDetail {
  return {
    ...cluster(),
    servers: [
      { id: "s1", name: "eu-1", status: "ONLINE", hostname: "eu-1", publicIp: null },
      { id: "s2", name: "eu-2", status: "ONLINE", hostname: "eu-2", publicIp: null },
    ],
    health: { nodes: { online: 2, offline: 1, pending: 0, total: 3 }, apps: { running: 0, stopped: 0, failed: 0, new: 0, total: 0 } },
    ...over,
  };
}

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("ClusterDeployCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listClusters").mockResolvedValue([cluster()]);
    vi.spyOn(api, "getCluster").mockResolvedValue(detail());
    // PlacementPicker (rendered when clusterId is set) reads live nodes; keep it quiet by default.
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue({ clusterId: "c1", swarmStatus: "ACTIVE", managerServerId: "s1", swarmLastError: null, nodes: [], live: [], quorum: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows node health for the selected (already-assigned) cluster", async () => {
    vi.spyOn(api, "getAppClusterStatus").mockResolvedValue({ desired: 2, running: 2, reachable: true, tasks: [] });
    wrap(<ClusterDeployCard id="app1" teamId="t1" clusterId="c1" replicas={2} placement={{ constraints: [], spreadLabelKey: null }} volumes={[]} constraintServerId={null} />);
    await waitFor(() => expect(screen.getByText(/2\/3 nodes online/)).toBeTruthy());
    expect(screen.getByText(/eu-1, eu-2/)).toBeTruthy();
  });

  it("warns when replicas exceed online nodes", async () => {
    vi.spyOn(api, "getAppClusterStatus").mockResolvedValue({ desired: 5, running: 2, reachable: true, tasks: [] });
    wrap(<ClusterDeployCard id="app1" teamId="t1" clusterId="c1" replicas={5} placement={{ constraints: [], spreadLabelKey: null }} volumes={[]} constraintServerId={null} />);
    // 5 replicas > 2 online nodes → capacity warning
    await waitFor(() => expect(screen.getByText(/5 replicas across 2 online node/)).toBeTruthy());
  });

  it("renders the live task table + running/desired when the app is deployed to the selected cluster", async () => {
    const status: AppClusterStatus = {
      desired: 3,
      running: 2,
      reachable: true,
      tasks: [
        { slot: "tugra_app1.1", node: "eu-1", desiredState: "Running", currentState: "Running 4 minutes ago", error: "" },
        { slot: "tugra_app1.2", node: "eu-2", desiredState: "Running", currentState: "Preparing", error: "" },
      ],
    };
    vi.spyOn(api, "getAppClusterStatus").mockResolvedValue(status);
    wrap(<ClusterDeployCard id="app1" teamId="t1" clusterId="c1" replicas={3} placement={{ constraints: [], spreadLabelKey: null }} volumes={[]} constraintServerId={null} />);
    await waitFor(() => expect(screen.getByText("tugra_app1.1")).toBeTruthy());
    expect(screen.getByText("tugra_app1.2")).toBeTruthy();
    expect(screen.getByText(/running 2\/3/)).toBeTruthy();
  });

  it("shows an unavailable hint (no crash) when the manager can't be reached", async () => {
    vi.spyOn(api, "getAppClusterStatus").mockResolvedValue({ desired: 2, running: 0, reachable: false, tasks: [] });
    wrap(<ClusterDeployCard id="app1" teamId="t1" clusterId="c1" replicas={2} placement={{ constraints: [], spreadLabelKey: null }} volumes={[]} constraintServerId={null} />);
    await waitFor(() => expect(screen.getByText(/Live replica status unavailable/)).toBeTruthy());
  });

  it("does NOT query live status for an unsaved new cluster selection (nothing deployed yet)", async () => {
    const statusSpy = vi.spyOn(api, "getAppClusterStatus").mockResolvedValue({ desired: 1, running: 0, reachable: true, tasks: [] });
    // app not yet assigned to any cluster → picking one shows the "save to deploy" hint, no live poll
    wrap(<ClusterDeployCard id="app1" teamId="t1" clusterId={null} replicas={null} placement={{ constraints: [], spreadLabelKey: null }} volumes={[]} constraintServerId={null} />);
    // wait for the cluster option to load before selecting it (jsdom ignores a value with no matching option)
    await screen.findByRole("option", { name: "prod-eu" });
    fireEvent.change(screen.getByLabelText(/Target cluster/), { target: { value: "c1" } });
    await waitFor(() => expect(screen.getByText(/Save to deploy to this cluster/)).toBeTruthy());
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("the replica stepper clamps to 1..100", async () => {
    vi.spyOn(api, "getAppClusterStatus").mockResolvedValue({ desired: 1, running: 1, reachable: true, tasks: [] });
    wrap(<ClusterDeployCard id="app1" teamId="t1" clusterId="c1" replicas={1} placement={{ constraints: [], spreadLabelKey: null }} volumes={[]} constraintServerId={null} />);
    const input = (await screen.findByLabelText("Replicas")) as HTMLInputElement;
    expect(input.value).toBe("1");
    fireEvent.click(screen.getByLabelText("Decrease replicas")); // can't go below 1
    expect(input.value).toBe("1");
    fireEvent.click(screen.getByLabelText("Increase replicas"));
    expect(input.value).toBe("2");
  });

  // ── stateful pin ──
  it("shows the pinned banner (resolving the node name) for a stateful app", async () => {
    vi.spyOn(api, "getAppClusterStatus").mockResolvedValue({ desired: 1, running: 1, reachable: true, tasks: [] });
    wrap(<ClusterDeployCard id="app1" teamId="t1" clusterId="c1" replicas={1} placement={{ constraints: [], spreadLabelKey: null }} volumes={[{ name: "data", path: "/data" }]} constraintServerId="s1" />);
    await waitFor(() => expect(screen.getByText("Pinned to eu-1 because it has persistent storage.")).toBeTruthy());
  });

  it("hides the replica stepper and always saves replicas:1 for a stateful app", async () => {
    const saveSpy = vi.spyOn(api, "setAppClusterConfig").mockResolvedValue({} as never);
    wrap(<ClusterDeployCard id="app1" teamId="t1" clusterId="c1" replicas={1} placement={{ constraints: [], spreadLabelKey: null }} volumes={[{ name: "data", path: "/data" }]} constraintServerId="s1" />);
    await screen.findByText(/1 replica \(pinned/);
    expect(screen.queryByLabelText("Replicas")).toBeNull(); // stepper gone
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith("app1", { clusterId: "c1", replicas: 1 }));
  });

  it("shows the pre-save stateful hint when a volumed app isn't pinned yet", async () => {
    wrap(<ClusterDeployCard id="app1" teamId="t1" clusterId="c1" replicas={1} placement={{ constraints: [], spreadLabelKey: null }} volumes={[{ name: "data", path: "/data" }]} constraintServerId={null} />);
    await waitFor(() => expect(screen.getByText(/hard-pins it to one node/)).toBeTruthy());
  });
});
