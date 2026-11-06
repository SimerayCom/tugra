import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { AppCrashTimelineCard } from "./app-crash-timeline-card";
import { api } from "../lib/api";
import type { AppRuntimeState, ContainerCrashEvent, ContainerRuntimeState } from "../lib/types";

afterEach(cleanup);

function container(over: Partial<ContainerRuntimeState> = {}): ContainerRuntimeState {
  return { containerName: "tugra_app1-web-1", status: "running", exitCode: 0, oomKilled: false, restartCount: 0, health: "healthy", startedAt: null, finishedAt: null, ...over };
}
function event(over: Partial<ContainerCrashEvent> = {}): ContainerCrashEvent {
  return { id: "e1", containerName: "tugra_app1-web-1", ts: "2026-11-06T10:00:00.000Z", kind: "crash", exitCode: 139, oomKilled: false, restartCount: 4, restartDelta: 1, reason: "Segmentation fault (SIGSEGV)", logTail: null, logRedacted: false, ...over };
}

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("AppCrashTimelineCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("queries runtime-state for the app id", async () => {
    const spy = vi.spyOn(api, "getAppRuntimeState").mockResolvedValue({ containers: [], events: [] });
    wrap(<AppCrashTimelineCard id="app1" />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("app1"));
  });

  it("shows an empty state when there are no containers or events", async () => {
    vi.spyOn(api, "getAppRuntimeState").mockResolvedValue({ containers: [], events: [] });
    wrap(<AppCrashTimelineCard id="app1" />);
    await waitFor(() => expect(screen.getByText(/No crashes recorded/)).toBeTruthy());
  });

  it("shows a distinct load-error state (never 'No crashes recorded') when the fetch fails with no data", async () => {
    // A crash-diagnosis card must not report a failed fetch as a clean bill of health.
    vi.spyOn(api, "getAppRuntimeState").mockRejectedValue(new Error("boom"));
    wrap(<AppCrashTimelineCard id="app1" />);
    await waitFor(() => expect(screen.getByText(/Couldn't load crash data/)).toBeTruthy());
    expect(screen.queryByText(/No crashes recorded/)).toBeNull();
  });

  it("renders a container summary with restart/exit badges and the human reason for an episode", async () => {
    const data: AppRuntimeState = {
      containers: [container({ status: "exited", exitCode: 137, restartCount: 9, finishedAt: "2026-11-06T09:59:00.000Z" })],
      events: [event()],
    };
    vi.spyOn(api, "getAppRuntimeState").mockResolvedValue(data);
    wrap(<AppCrashTimelineCard id="app1" />);
    await waitFor(() => expect(screen.getByText("Restarts 9")).toBeTruthy());
    expect(screen.getByText("Exit 137")).toBeTruthy();
    // Friendly compose-service name, raw name kept in the title.
    expect(screen.getAllByTitle("tugra_app1-web-1").length).toBeGreaterThan(0);
    expect(screen.getByText("Segmentation fault (SIGSEGV)")).toBeTruthy();
  });

  it("renders the frozen log tail verbatim (as text, not HTML) when present", async () => {
    const injection = "<script>alert(1)</script> env: SECRET=shh";
    vi.spyOn(api, "getAppRuntimeState").mockResolvedValue({ containers: [], events: [event({ logTail: injection })] });
    wrap(<AppCrashTimelineCard id="app1" />);
    await waitFor(() => expect(screen.getByText(injection)).toBeTruthy());
  });

  it("shows a redacted note instead of the log when the caller may not read it", async () => {
    vi.spyOn(api, "getAppRuntimeState").mockResolvedValue({ containers: [], events: [event({ logTail: null, logRedacted: true })] });
    wrap(<AppCrashTimelineCard id="app1" />);
    await waitFor(() => expect(screen.getByText(/hidden/i)).toBeTruthy());
  });

  it("does NOT paint 'Exit 0/137' on a currently-running container that carries a stale last exit code", async () => {
    vi.spyOn(api, "getAppRuntimeState").mockResolvedValue({
      containers: [container({ status: "running", exitCode: 137, restartCount: 0 })],
      events: [],
    });
    wrap(<AppCrashTimelineCard id="app1" />);
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());
    expect(screen.queryByText("Exit 137")).toBeNull();
  });

  it("labels an OOM episode and shows the restart delta badge", async () => {
    vi.spyOn(api, "getAppRuntimeState").mockResolvedValue({
      containers: [],
      events: [event({ kind: "oom", oomKilled: true, exitCode: 137, restartDelta: 2, reason: "Killed — out of memory (137)" })],
    });
    wrap(<AppCrashTimelineCard id="app1" />);
    await waitFor(() => expect(screen.getByText("Out of memory")).toBeTruthy());
    expect(screen.getByText("+2 restart")).toBeTruthy();
    expect(screen.getByText("Exit 137")).toBeTruthy();
  });

  it("simplifies swarm task container names to their service (raw name kept in the title)", async () => {
    vi.spyOn(api, "getAppRuntimeState").mockResolvedValue({
      containers: [
        container({ containerName: "tugra_ck123-web.2.def456xyz", status: "running" }),
        container({ containerName: "tugra_ck999.1.abc789qrs", status: "running" }),
      ],
      events: [],
    });
    wrap(<AppCrashTimelineCard id="app1" />);
    await waitFor(() => expect(screen.getByText("web")).toBeTruthy());
    expect(screen.getByText("container")).toBeTruthy();
    expect(screen.getByTitle("tugra_ck123-web.2.def456xyz")).toBeTruthy();
  });
});
