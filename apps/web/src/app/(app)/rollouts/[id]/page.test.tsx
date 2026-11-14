import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { ConfirmProvider } from "../../../../components/confirm";
import { api } from "../../../../lib/api";
import type { Rollout, RolloutTarget } from "../../../../lib/types";
import RolloutDetailPage from "./page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "r1" }), useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);
let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <RolloutDetailPage />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const target = (id: string, wave: number, status: RolloutTarget["status"], over: Partial<RolloutTarget> = {}): RolloutTarget => ({
  id,
  appId: `app-${id}`,
  serverId: "s1",
  label: `app ${id}`,
  wave,
  position: 0,
  status,
  attempt: 1,
  deploymentId: status === "PENDING" ? null : `dep-${id}`,
  baselineDeploymentId: null,
  rollbackDeploymentId: null,
  outcome: status === "FAILED" ? "rejected_safe" : status === "SUCCEEDED" ? "passed" : null,
  detail: null,
  dispatchedAt: null,
  finishedAt: null,
  ...over,
});
const rollout = (over: Partial<Rollout> = {}): Rollout => ({
  id: "r1",
  teamId: "t1",
  createdBy: "u1",
  name: "release 42",
  kind: "app_deploy",
  status: "HALTED",
  haltReason: "wave_failed",
  haltDetail: null,
  config: { canary: 1, steps: [100], concurrency: 3, maxFailuresPerWave: 0, bakeSec: 0, dispatchTimeoutSec: 2700, waitOnlineSec: 300, allowUngated: false, noCache: false },
  currentWave: 1,
  waveCount: 2,
  waveSizes: [1, 2],
  bakeUntil: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  summary: { total: 3, pending: 1, deploying: 0, succeeded: 1, failed: 1, skipped: 0, cancelled: 0 },
  targets: [target("a", 0, "SUCCEEDED"), target("b", 1, "FAILED"), target("c", 1, "PENDING")],
  ...over,
});

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => vi.restoreAllMocks());

describe("RolloutDetailPage", () => {
  it("renders the waves with per-target status and outcome, the halt banner, and only the actions the state allows", async () => {
    vi.spyOn(api, "getRollout").mockResolvedValue(rollout());
    wrap();
    await waitFor(() => expect(screen.getByText("release 42")).toBeTruthy());
    expect(screen.getByText("Canary")).toBeTruthy();
    expect(screen.getByText("Wave 2")).toBeTruthy();
    expect(screen.getByText(/A wave had more failures than allowed/)).toBeTruthy();
    expect(screen.getByText(/Health gate rejected the new version/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel rollout" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Halt" })).toBeNull();
    expect(screen.getByRole("link", { name: "app b" }).getAttribute("href")).toBe("/apps/app-b");
  });

  it("Resume asks for confirmation, then calls the API and shows the returned state", async () => {
    vi.spyOn(api, "getRollout").mockResolvedValue(rollout());
    const resume = vi.spyOn(api, "resumeRollout").mockResolvedValue(rollout({ status: "RUNNING", haltReason: null }));
    wrap();
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.getByText(/Resume this rollout\?/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Halt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("a completed rollout offers only the fleet rollback; Roll back fleet confirms, calls the API and shows ROLLING_BACK", async () => {
    vi.spyOn(api, "getRollout").mockResolvedValue(rollout({ status: "COMPLETED", haltReason: null, finishedAt: new Date().toISOString(), summary: { total: 3, pending: 0, deploying: 0, succeeded: 2, failed: 1, skipped: 0, cancelled: 0 } }));
    const rb = vi.spyOn(api, "rollbackRollout").mockResolvedValue(rollout({ status: "ROLLING_BACK", haltReason: null, targets: [target("a", 0, "REVERTING"), target("b", 1, "REVERTING"), target("c", 1, "SKIPPED", { outcome: "superseded" })] }));
    wrap();
    await waitFor(() => expect(screen.getByText("Completed")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Halt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel rollout" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Roll back fleet" }));
    await waitFor(() => expect(screen.getByText(/Roll back this rollout\?/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(rb).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(screen.getByText("Rolling back")).toBeTruthy());
    expect(screen.getAllByText("Reverting")).toHaveLength(2);
    expect(screen.getByText(/left untouched/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Roll back fleet" })).toBeNull();
  });

  it("a running rollout never offers the fleet rollback", async () => {
    vi.spyOn(api, "getRollout").mockResolvedValue(rollout({ status: "RUNNING", haltReason: null }));
    wrap();
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Roll back fleet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Halt" })).toBeTruthy();
  });
});
