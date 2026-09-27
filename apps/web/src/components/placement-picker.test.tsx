import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { PlacementPicker } from "./placement-picker";
import { api } from "../lib/api";
import type { SwarmLiveNode, SwarmView } from "../lib/types";

afterEach(cleanup);

const swarm = (live: Partial<SwarmLiveNode>[]): SwarmView => ({
  clusterId: "c1",
  swarmStatus: "ACTIVE",
  managerServerId: "n1",
  swarmLastError: null,
  nodes: [],
  live: live.map((l) => ({ id: "x", hostname: "h", role: "worker", state: "ready", availability: "active", labels: {}, ...l })),
});

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("PlacementPicker", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("populates the node-value dropdown from the live hostnames", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(
      swarm([
        { id: "n1", hostname: "web-1", labels: {} },
        { id: "n2", hostname: "web-2", labels: { zone: "east" } },
      ]),
    );
    wrap(<PlacementPicker appId="app1" clusterId="c1" initial={{ constraints: [{ type: "hostname", op: "eq", value: "web-1" }], spreadLabelKey: null }} canWrite />);
    await waitFor(() => expect(screen.getByRole("option", { name: "web-1" })).toBeTruthy());
    expect(screen.getByRole("option", { name: "web-2" })).toBeTruthy();
  });

  it("Save is disabled until dirty, then calls setAppPlacement with the built payload", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(swarm([{ id: "n1", hostname: "web-1", labels: {} }]));
    const saveSpy = vi.spyOn(api, "setAppPlacement").mockResolvedValue({ ok: true });
    wrap(<PlacementPicker appId="app1" clusterId="c1" initial={{ constraints: [], spreadLabelKey: null }} canWrite />);
    const addBtn = await screen.findByText("+ Add rule");
    // not dirty yet → Save disabled
    expect((screen.getByText("Save placement") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(addBtn); // adds a hostname rule pinned to web-1 → dirty
    fireEvent.click(screen.getByText("Save placement"));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith("app1", { constraints: [{ type: "hostname", op: "eq", value: "web-1" }], spreadLabelKey: null }));
  });

  it("shows the true stored hostname as a disabled option when its node is no longer live", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(swarm([{ id: "n1", hostname: "web-1", labels: {} }]));
    wrap(<PlacementPicker appId="app1" clusterId="c1" initial={{ constraints: [{ type: "hostname", op: "eq", value: "worker-3" }], spreadLabelKey: null }} canWrite />);
    const opt = (await screen.findByRole("option", { name: /worker-3/ })) as HTMLOptionElement;
    expect(opt.disabled).toBe(true); // never silently default to a live node that isn't the real pin
  });

  it("shows the no-live-nodes hint and no Add-rule affordance when the cluster has no live nodes", async () => {
    vi.spyOn(api, "getSwarmStatus").mockResolvedValue(swarm([]));
    wrap(<PlacementPicker appId="app1" clusterId="c1" initial={{ constraints: [], spreadLabelKey: null }} canWrite />);
    await waitFor(() => expect(screen.getByText(/No live nodes/)).toBeTruthy());
    expect(screen.queryByText("+ Add rule")).toBeNull();
  });
});
