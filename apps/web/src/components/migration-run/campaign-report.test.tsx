import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
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
    vi.spyOn(api, "listCampaigns").mockResolvedValue([]);
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

  describe("waves and cancelling", () => {
    const plan = [
      { sourceServerRef: "b", kind: "other-server" as const, targetServerId: "new1", topology: "two-box" as const, wave: 0 },
      { sourceServerRef: "a", kind: "in-place" as const, targetServerId: "srv-a", topology: "swap-proxy" as const, wave: 1 },
    ];
    const view = (over: Record<string, unknown> = {}) => ({ id: "camp1", teamId: "t1", label: "wave-1", sessionId: "s1", status: "draft" as const, plan, runIds: ["run-aaaa1111", "run-bbbb2222"], createdAt: "2026-11-24T08:00:00.000Z", ...over });
    beforeEach(() => {
      vi.mocked(api.listMigrationRuns).mockResolvedValue([
        mkSummary({ id: "run-aaaa1111", campaign: "wave-1", targetServerId: "new1", inPlace: false, status: "COMPLETED", currentStep: null, createdAt: "2026-11-24T09:00:00.000Z" }),
        mkSummary({ id: "run-bbbb2222", campaign: "wave-1", targetServerId: "srv-a", inPlace: true, topology: "swap-proxy", status: "QUEUED", currentStep: null, createdAt: "2026-11-24T10:00:00.000Z" }),
      ]);
    });

    it("shows each run's wave and marks the one to start next", async () => {
      vi.mocked(api.listCampaigns).mockResolvedValue([view()]);
      wrap();
      await screen.findByText("Wave 2");
      expect(screen.getByText("Wave 1")).toBeTruthy();
      expect(screen.getAllByText("Start this next")).toHaveLength(1);
      const next = screen.getByText("Start this next").closest("li")!;
      expect(next.textContent).toContain("Wave 2");
      expect(screen.getByText(/Waves run one after the other/)).toBeTruthy();
    });

    it("cancel needs the typed label, calls the hub once per campaign and says what happened", async () => {
      vi.mocked(api.listCampaigns).mockResolvedValue([view()]);
      const cancel = vi.spyOn(api, "cancelCampaign").mockResolvedValue(view({ status: "cancelled" }));
      wrap();
      fireEvent.click(await screen.findByRole("button", { name: "Cancel campaign" }));
      const dialog = await screen.findByRole("dialog");
      const confirm = within(dialog).getByRole("button", { name: "Cancel campaign" }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      fireEvent.change(within(dialog).getByPlaceholderText("wave-1"), { target: { value: "wave-1" } });
      await waitFor(() => expect(confirm.disabled).toBe(false));
      fireEvent.click(confirm);
      await waitFor(() => expect(cancel).toHaveBeenCalledWith("camp1"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("a cancelled or finished campaign has no cancel button and nothing to start next", async () => {
      vi.mocked(api.listCampaigns).mockResolvedValue([view({ status: "cancelled" })]);
      wrap();
      await screen.findByText("Wave 2");
      expect(screen.queryByRole("button", { name: "Cancel campaign" })).toBeNull();
      expect(screen.queryByText("Start this next")).toBeNull();
    });
  });
});
