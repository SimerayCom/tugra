import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
    // the hub honours the `active` filter: the roll-up must not be built from that filtered answer
    vi.spyOn(api, "listMigrationRuns").mockImplementation(async (f = {}) => {
      const all = [row("a", "COMPLETED"), row("b", "WAITING"), row("c", "DRY_RUN_DONE"), row("d", "ABORTED"), row("e", "FAILED")];
      return f.active ? all.filter((r) => r.status === "WAITING" || r.status === "FAILED") : all;
    });
  });

  it("counts every run of the campaign, from a query that carries neither the active nor the campaign filter", async () => {
    wrap();
    await screen.findByText(/5 runs: 1 completed, 1 live, 1 failed, 2 dry-run or stopped/);
    const calls = vi.mocked(api.listMigrationRuns).mock.calls.map((c) => c[0] ?? {});
    expect(calls.some((f) => !f.active && !f.campaign && f.limit === 200)).toBe(true);
  });

  it("links each campaign to its own report", async () => {
    wrap();
    await screen.findByText(/5 runs:/);
    const link = screen.getByRole("link", { name: "Campaign report" });
    expect(link.getAttribute("href")).toBe("/import/runs/campaign?c=wave-1");
  });

  it("says the counts are a lower bound when the roll-up query hit its cap", async () => {
    vi.mocked(api.listMigrationRuns).mockRestore();
    vi.spyOn(api, "listMigrationRuns").mockImplementation(async (f = {}) => Array.from({ length: f.limit ?? 50 }, (_, i) => row(`r${i}`, "COMPLETED")));
    wrap();
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
