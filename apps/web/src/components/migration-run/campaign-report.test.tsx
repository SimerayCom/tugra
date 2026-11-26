import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import { CampaignReport } from "./campaign-report";
import { mkSummary } from "./test-fixtures";
import type { MigrationRunReport, MigrationRunSummary } from "../../lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("../team-scope", () => ({ useTeamContext: () => ({ teams: [{ id: "t-a", name: "Team A" }, { id: "t-b", name: "Team B" }] }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const report = (runId: string, over: Partial<MigrationRunReport> = {}): MigrationRunReport => ({
  runId, generatedAt: "2026-11-25T10:00:00.000Z", status: "COMPLETED", mode: "copy", topology: "two-box", dryRun: false,
  source: { kind: "coolify", host: "src.example.test" }, target: { serverId: "srv1", serverName: "tugra-1" },
  targets: [{ serverId: "srv1", serverName: "tugra-1" }, { serverId: "srv2", serverName: "tugra-2" }],
  campaign: "wave-1", ponrAt: null, window: { estimatedSec: 600, measuredSec: 420 }, steps: [], evidenceSummary: {}, manual: [],
  items: [{ kind: "app", name: "app-a", outcome: "moved", code: null, evidence: null }, { kind: "app", name: "app-b", outcome: "not-cut-over", code: "cutover.host-held", evidence: null }],
  ...over,
});

const wrap = (campaign = "wave-1") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <CampaignReport campaign={campaign} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("CampaignReport", () => {
  const runs: MigrationRunSummary[] = [
    mkSummary({ id: "run-aaaa1111", campaign: "wave-1", sourceHost: "src-a.example.test", status: "COMPLETED", currentStep: null, createdAt: "2026-11-24T09:00:00.000Z" }),
    mkSummary({ id: "run-bbbb2222", campaign: "wave-1", sourceHost: "src-b.example.test", status: "FAILED", currentStep: "DATA_FINAL", failure: { step: "DATA_FINAL", code: "data-final.host-failed" }, createdAt: "2026-11-24T10:00:00.000Z" }),
    mkSummary({ id: "run-cccc3333", campaign: "wave-1", sourceHost: "src-c.example.test", status: "WAITING", currentStep: "VERIFY", nextActionKind: "approval", createdAt: "2026-11-24T11:00:00.000Z" }),
  ];

  beforeEach(() => {
    vi.spyOn(api, "listMigrationRuns").mockResolvedValue(runs);
    vi.spyOn(api, "getMigrationRunReport").mockImplementation(async (id: string) => {
      if (id === "run-bbbb2222") return report(id, { window: { estimatedSec: 300, measuredSec: null }, items: [{ kind: "database", name: "db-big", outcome: "failed", code: "data.dump-too-big", evidence: null }] });
      if (id === "run-cccc3333") throw new Error("no report");
      return report(id);
    });
  });

  it("lists every run of the campaign with its state, hosts and window, and totals the windows", async () => {
    wrap();
    await screen.findByText(/3 runs: 1 completed, 1 live, 1 failed, 0 dry-run or stopped/);
    expect(vi.mocked(api.listMigrationRuns).mock.calls[0][0]).toMatchObject({ campaign: "wave-1" });
    // one card per run, each a link to its own page, in creation order
    const links = screen.getAllByRole("link", { name: /Open run/ });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/import/runs/run-aaaa1111", "/import/runs/run-bbbb2222", "/import/runs/run-cccc3333"]);
    await waitFor(() => expect(screen.getByText(/src-a.example.test to tugra-1, tugra-2/)).toBeTruthy());
    expect(screen.getAllByText(/Window 10 min estimated, 7 min measured/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Source hosts: src-a.example.test, src-b.example.test, src-c.example.test/)).toBeTruthy();
    expect(screen.getByText(/Measured downtime in total: 7 min/)).toBeTruthy();
    expect(screen.getByText(/Longest window: 7 min/)).toBeTruthy();
    // the failed run's report counts its items, the unreadable one says so by having no counts
    expect(screen.getByText(/1 moved, 1 failed, 1 not cut over, 0 skipped, 0 accepted/)).toBeTruthy();
  });

  it("names what failed and what stayed on the source, with the reason", async () => {
    wrap();
    const section = (await screen.findByText("What failed or was not cut over")).closest("section, div")!.parentElement!;
    await waitFor(() => expect(within(section).getByText("db-big")).toBeTruthy());
    expect(within(section).getByText("app-b")).toBeTruthy();
    expect(within(section).getAllByText("Failed").length).toBeGreaterThanOrEqual(2); // the run itself and the database
    expect(within(section).getByText("Not cut over")).toBeTruthy();
  });

  it("says so when no run carries the label, and asks for a label when there is none", async () => {
    vi.mocked(api.listMigrationRuns).mockResolvedValue([]);
    wrap("wave-9");
    await screen.findByText("No run carries this campaign label.");
    cleanup();
    wrap("");
    await screen.findByText("Choose a campaign on the runs page to see its report.");
    expect(vi.mocked(api.listMigrationRuns)).toHaveBeenCalledTimes(1); // an empty label asks the hub for nothing
  });

  it("reads each run's report once, and leaves the runs of another campaign out", async () => {
    vi.mocked(api.listMigrationRuns).mockResolvedValue([...runs, mkSummary({ id: "run-dddd4444", campaign: "wave-2" })]);
    wrap();
    await screen.findByText(/3 runs:/);
    await waitFor(() => expect(vi.mocked(api.getMigrationRunReport)).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.getMigrationRunReport).mock.calls.map((c) => c[0]).sort()).toEqual(["run-aaaa1111", "run-bbbb2222", "run-cccc3333"]);
  });
  it("a campaign made in several teams is one report: every run, each marked with its team, whatever team is in view", async () => {
    vi.mocked(api.listMigrationRuns).mockResolvedValue([
      mkSummary({ id: "run-aaaa1111", teamId: "t-a", campaign: "wave-1", sourceHost: "src-a.example.test", status: "COMPLETED", currentStep: null, createdAt: "2026-11-24T09:00:00.000Z" }),
      mkSummary({ id: "run-bbbb2222", teamId: "t-b", campaign: "wave-1", sourceHost: "src-b.example.test", status: "COMPLETED", currentStep: null, createdAt: "2026-11-24T10:00:00.000Z" }),
    ]);
    wrap();
    await screen.findByText(/2 runs: 2 completed/);
    expect(screen.getByText("Teams: Team A, Team B")).toBeTruthy();
    expect(screen.getAllByText("Team A").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Team B").length).toBeGreaterThanOrEqual(1);
  });

  it("one team: no team marks", async () => {
    wrap();
    await screen.findByText(/3 runs/);
    expect(screen.queryByText(/^Teams:/)).toBeNull();
  });
});
