import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { CONTAINER_LIST_FAST_MS, CONTAINER_LIST_SLOW_MS } from "../../../../lib/log-container";

// Capture what the logs card is asked to stream instead of opening a real SSE stream.
const liveProps: { container?: string; active?: boolean; emptyHint?: React.ReactNode }[] = [];
vi.mock("../../../../components/live-logs-card", () => ({
  LiveLogsCard: (p: { container?: string; active?: boolean; emptyHint?: React.ReactNode; headerExtra?: React.ReactNode }) => {
    liveProps.push({ container: p.container, active: p.active, emptyHint: p.emptyHint });
    return (
      <div>
        {p.headerExtra}
        <div data-testid="state">{p.active ? `streaming:${p.container ?? "-"}` : "idle"}</div>
        {!p.active && <div data-testid="hint">{p.emptyHint}</div>}
      </div>
    );
  },
}));

import { LiveContainerLogsCard } from "./app-detail-tabs";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

let qc: QueryClient;
beforeEach(() => {
  liveProps.length = 0;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
const show = (ui: React.ReactNode) => render(<QueryClientProvider client={qc}><I18nProvider>{ui}</I18nProvider></QueryClientProvider>);

const IMMICH = [
  { name: "tugra_ck1abc-database-1", state: "running" },
  { name: "tugra_ck1abc-redis-1", state: "running" },
  { name: "tugra_ck1abc-immich-1", state: "running" },
];

describe("LiveContainerLogsCard — compose logs show at once", () => {
  it("starts streaming the app's main service as soon as the container list arrives (no 'pick a container' wall)", async () => {
    vi.spyOn(api, "listAppContainers").mockResolvedValue({ containers: IMMICH });
    show(<LiveContainerLogsCard id="a1" isCompose appName="Immich" />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("streaming:tugra_ck1abc-immich-1"));
    expect(screen.queryByText(/Pick a container to stream/)).toBeNull();
    // The picker button names the followed service, so the user can see (and change) what they are looking at.
    expect(screen.getByRole("button", { name: "immich" })).toBeTruthy();
  });

  it("says it is finding the containers while the list loads, not 'pick a container'", () => {
    vi.spyOn(api, "listAppContainers").mockReturnValue(new Promise(() => undefined));
    show(<LiveContainerLogsCard id="a1" isCompose appName="Immich" />);
    expect(screen.getByTestId("hint").textContent).toMatch(/Finding the app's containers/);
  });

  it("prefers a service that serves a link", async () => {
    vi.spyOn(api, "listAppContainers").mockResolvedValue({ containers: [{ name: "tugra_ck1abc-api-1", state: "running" }, { name: "tugra_ck1abc-web-1", state: "running" }] });
    show(<LiveContainerLogsCard id="a1" isCompose appName="Shop" services={["web"]} />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("streaming:tugra_ck1abc-web-1"));
  });

  it("lets the user switch with the picker and keeps their choice", async () => {
    vi.spyOn(api, "listAppContainers").mockResolvedValue({ containers: IMMICH });
    show(<LiveContainerLogsCard id="a1" isCompose appName="Immich" />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("streaming:tugra_ck1abc-immich-1"));
    fireEvent.click(screen.getByRole("button", { name: "immich" }));
    fireEvent.click(await screen.findByText("tugra_ck1abc-redis-1"));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("streaming:tugra_ck1abc-redis-1"));
  });

  it("reports an empty compose app instead of streaming nothing", async () => {
    vi.spyOn(api, "listAppContainers").mockResolvedValue({ containers: [] });
    show(<LiveContainerLogsCard id="a1" isCompose appName="Immich" />);
    await waitFor(() => expect(screen.getByTestId("hint").textContent).toMatch(/No containers found/));
    expect(screen.getByTestId("state").textContent).toBe("idle");
  });

  it("does not list containers for a never-deployed app", () => {
    const spy = vi.spyOn(api, "listAppContainers");
    show(<LiveContainerLogsCard id="a1" isCompose neverDeployed />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("hint").textContent).toMatch(/after the first deploy/);
  });

  it("a single-container app streams straight away without listing containers", () => {
    const spy = vi.spyOn(api, "listAppContainers");
    show(<LiveContainerLogsCard id="a1" isCompose={false} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toBe("streaming:-");
  });

  it("a swarm compose app streams the aggregated service logs straight away", () => {
    const spy = vi.spyOn(api, "listAppContainers");
    show(<LiveContainerLogsCard id="a1" isCompose clustered />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toBe("streaming:-");
  });
});

describe("LiveContainerLogsCard — the container list stays fresh", () => {
  afterEach(() => vi.useRealTimers());

  it("picks up the containers once a deploy/restart finishes, without a remount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(api, "listAppContainers")
      .mockResolvedValueOnce({ containers: [] })
      .mockResolvedValue({ containers: IMMICH });
    show(<LiveContainerLogsCard id="a1" isCompose appName="Immich" />);
    await waitFor(() => expect(screen.getByTestId("hint").textContent).toMatch(/No containers found/));
    await vi.advanceTimersByTimeAsync(CONTAINER_LIST_FAST_MS + 100);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("streaming:tugra_ck1abc-immich-1"));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stays on the followed container when a refreshed list is ordered differently", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, "listAppContainers")
      .mockResolvedValueOnce({ containers: [{ name: "tugra_ck1abc-api-1", state: "running" }, { name: "tugra_ck1abc-worker-1", state: "running" }] })
      .mockResolvedValue({ containers: [{ name: "tugra_ck1abc-worker-1", state: "running" }, { name: "tugra_ck1abc-api-1", state: "running" }] });
    show(<LiveContainerLogsCard id="a1" isCompose />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("streaming:tugra_ck1abc-api-1"));
    await vi.advanceTimersByTimeAsync(CONTAINER_LIST_SLOW_MS + 100);
    expect(screen.getByTestId("state").textContent).toBe("streaming:tugra_ck1abc-api-1");
  });
});
