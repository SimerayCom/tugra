import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import { RunList } from "./run-list";
import type { MigrationRunSummary } from "../../lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../team-scope", () => ({ useTeamScope: () => ({ teamId: null }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row = (id: string, status: MigrationRunSummary["status"], campaign: string | null = "wave-1"): MigrationRunSummary =>
  ({
    id,
    teamId: "t1",
    targetServerId: "srv1",
    targetServerName: "tugra-1",
    targetServerCount: 1,
    sourceKind: "coolify",
    sourceHost: "src.example.test",
    sourceVersion: null,
    campaign,
    mode: "copy",
    topology: "two-box",
    dryRun: false,
    status,
    currentStep: null,
    ponrAt: null,
    stepsTotal: 13,
    stepsPassed: 0,
    nextActionKind: "none",
    failure: null,
    createdAt: "2026-11-16T10:00:00.000Z",
    updatedAt: "2026-11-16T10:00:00.000Z",
  }) as unknown as MigrationRunSummary;

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <RunList />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("RunList campaign roll-up", () => {
  beforeEach(() => {
    vi.spyOn(api, "listMigrationRuns").mockImplementation(async () => [row("a", "COMPLETED"), row("b", "WAITING"), row("c", "DRY_RUN_DONE"), row("d", "ABORTED"), row("e", "FAILED")]);
  });

  it("counts every run of the campaign from one query that carries no filter, so the chip, the tabs and the rows agree", async () => {
    wrap();
    await screen.findByText(/5 runs: 1 completed, 1 live, 1 failed, 2 dry-run or stopped/);
    const calls = vi.mocked(api.listMigrationRuns).mock.calls.map((c) => c[0] ?? {});
    expect(calls.every((f) => !f.active && !f.campaign && f.limit === 200)).toBe(true);
  });

  it("the whole chip is the link to the campaign's page, by its id when the campaign is readable", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "OWNER" }] as never);
    vi.spyOn(api, "listCampaigns").mockResolvedValue([{ id: "camp-7", teamId: "t1", label: "wave-1", sessionId: null, status: "running", plan: [], runIds: ["a"], createdAt: "2026-11-16T10:00:00Z" }]);
    wrap();
    const chip = (await screen.findByText(/5 runs:/)).closest("a");
    await waitFor(() => expect(chip?.getAttribute("href")).toBe("/import/runs/campaign?id=camp-7"));
  });

  it("falls back to the label's own address when the campaign cannot be read", async () => {
    wrap();
    const chip = (await screen.findByText(/5 runs:/)).closest("a");
    expect(chip?.getAttribute("href")).toBe("/import/runs/campaign?c=wave-1");
  });

  it("hides a campaign that only has cancelled runs until its tab is chosen, and counts it there", async () => {
    vi.mocked(api.listMigrationRuns).mockResolvedValue([row("x", "ABORTED", "old-move"), row("y", "ABORTED", "old-move")]);
    wrap();
    await screen.findByText("Nothing in this tab");
    expect(screen.queryByText(/2 runs:/)).toBeNull();
    const cancelled = screen.getByRole("tab", { name: /Cancelled/ });
    expect(cancelled.textContent).toContain("2");
    fireEvent.click(cancelled);
    await screen.findByText(/2 runs: 0 completed, 0 live, 0 failed, 2 dry-run or stopped/);
  });

  it("says the counts are a lower bound when the roll-up query hit its cap", async () => {
    vi.mocked(api.listMigrationRuns).mockRestore();
    vi.spyOn(api, "listMigrationRuns").mockImplementation(async (f = {}) => Array.from({ length: f.limit ?? 50 }, (_, i) => row(`r${i}`, "COMPLETED")));
    wrap();
    fireEvent.click(await screen.findByRole("tab", { name: /Done/ }));
    await waitFor(() => expect(screen.getByText(/At least 200 runs/)).toBeTruthy());
  });
});

describe("RunList in-place badge", () => {
  it("marks a run that takes a server over in place, and only that one", async () => {
    vi.spyOn(api, "listMigrationRuns").mockResolvedValue([{ ...row("ip", "RUNNING", null), inPlace: true }, { ...row("cp", "RUNNING", null), inPlace: false }]);
    wrap();
    await waitFor(() => expect(screen.getAllByTestId("in-place-badge")).toHaveLength(1));
    expect(screen.getByTestId("in-place-badge").textContent).toBe("In place");
  });
});
