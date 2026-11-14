import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { Rollout } from "../../../lib/types";
import RolloutsPage from "./page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../../../components/team-scope", () => ({ useTeamScope: () => ({ teamId: null, setTeamId: vi.fn() }) }));

afterEach(cleanup);
let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <RolloutsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );

const rollout = (over: Partial<Rollout> = {}): Rollout => ({
  id: "r1abcdef",
  teamId: "t1",
  createdBy: "u1",
  name: "v2 to prod",
  kind: "app_deploy",
  status: "HALTED",
  haltReason: "wave_failed",
  haltDetail: null,
  config: { canary: 1, steps: [25, 50, 100], concurrency: 3, maxFailuresPerWave: 0, bakeSec: 60, dispatchTimeoutSec: 2700, waitOnlineSec: 300, allowUngated: false, noCache: false },
  currentWave: 1,
  waveCount: 3,
  waveSizes: [1, 2, 3],
  bakeUntil: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  summary: { total: 6, pending: 3, deploying: 0, succeeded: 2, failed: 1, skipped: 0, cancelled: 0 },
  targets: [],
  ...over,
});

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team One" }] as never);
  vi.spyOn(api, "listApps").mockResolvedValue([
    { id: "a1", name: "api", teamId: "t1" },
    { id: "a2", name: "web", teamId: "t1" },
  ] as never);
});
afterEach(() => vi.restoreAllMocks());

describe("RolloutsPage", () => {
  it("lists rollouts with status, wave and progress; a row opens the detail page", async () => {
    vi.spyOn(api, "listRollouts").mockResolvedValue([rollout()]);
    wrap();
    await waitFor(() => expect(screen.getByText("v2 to prod")).toBeTruthy());
    expect(screen.getByText("Halted")).toBeTruthy();
    expect(screen.getByText(/Wave 2 of 3/)).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    fireEvent.click(screen.getByText("v2 to prod"));
    expect(push).toHaveBeenCalledWith("/rollouts/r1abcdef");
  });

  it("shows the empty state when there are none", async () => {
    vi.spyOn(api, "listRollouts").mockResolvedValue([]);
    wrap();
    await waitFor(() => expect(screen.getByText("No rollouts yet")).toBeTruthy());
  });

  it("the new-rollout modal previews the plan as apps are picked and starts only when nothing is blocked", async () => {
    vi.spyOn(api, "listRollouts").mockResolvedValue([]);
    const plan = vi.spyOn(api, "planRollout").mockResolvedValue({
      teamId: "t1",
      waveSizes: [1, 1],
      blocked: 0,
      targets: [
        { appId: "a1", name: "api", serverId: "s1", wave: 0, blocked: null, warnings: ["auto_deploy_on"] },
        { appId: "a2", name: "web", serverId: "s1", wave: 1, blocked: null, warnings: [] },
      ],
    });
    const create = vi.spyOn(api, "createRollout").mockResolvedValue(rollout({ id: "new1", status: "RUNNING" }));
    wrap();
    await waitFor(() => expect(screen.getByRole("button", { name: "New rollout" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New rollout" }));
    await waitFor(() => expect(screen.getByLabelText("api")).toBeTruthy());
    const start = screen.getByRole("button", { name: "Start rollout" });
    expect(start).toHaveProperty("disabled", true); // nothing picked yet
    fireEvent.click(screen.getByLabelText("api"));
    fireEvent.click(screen.getByLabelText("web"));
    await waitFor(() => expect(plan).toHaveBeenCalled());
    expect(plan.mock.calls.at(-1)![0]).toMatchObject({ appIds: ["a1", "a2"], config: expect.objectContaining({ canary: 1, steps: [25, 50, 100], bakeSec: 60 }) });
    await waitFor(() => expect(screen.getByText(/2 waves: 1 → 1/)).toBeTruthy());
    expect(screen.getByText(/push-to-deploy is on/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start rollout" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Start rollout" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(push).toHaveBeenCalledWith("/rollouts/new1"));
  });

  it("a blocked app disables Start and names the reason; an invalid steps field is flagged", async () => {
    vi.spyOn(api, "listRollouts").mockResolvedValue([]);
    vi.spyOn(api, "planRollout").mockResolvedValue({
      teamId: "t1",
      waveSizes: [],
      blocked: 1,
      targets: [{ appId: "a1", name: "api", serverId: "s1", wave: null, blocked: "ungated", warnings: [] }],
    });
    wrap();
    await waitFor(() => expect(screen.getByRole("button", { name: "New rollout" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New rollout" }));
    await waitFor(() => expect(screen.getByLabelText("api")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("api"));
    await waitFor(() => expect(screen.getByText(/No health gate with auto-rollback/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Start rollout" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByPlaceholderText("25, 50, 100"), { target: { value: "50, 25" } });
    await waitFor(() => expect(screen.getByText("Waves must be increasing percentages ending at 100")).toBeTruthy());
  });
});
