import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import { CampaignReport } from "./campaign-report";
import { binding, mkRun, mkStep, mkSummary } from "./test-fixtures";
import { MIGRATION_RUN_STEP_KEYS } from "../../lib/migration-run";
import type { MigrationRunReport, MigrationRunStepKey, MigrationRunStepView, MigrationRunSummary, MigrationRunView } from "../../lib/types";

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

    it("shows each run's wave, says that closing the page stops nothing, and no longer sends the owner to start every run by hand", async () => {
      vi.mocked(api.listCampaigns).mockResolvedValue([view()]);
      wrap();
      await screen.findByText("Wave 2 of 2");
      expect(screen.getByText("Wave 1 of 2")).toBeTruthy();
      expect(screen.queryByText("Start this next")).toBeNull();
      expect(screen.queryByText(/Start the run marked/)).toBeNull();
      expect(screen.getByTestId("campaign-close-note").textContent).toMatch(/Closing this page does not stop anything/);
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
      await screen.findByText("Wave 2 of 2");
      expect(screen.queryByRole("button", { name: "Cancel campaign" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Start moving/ })).toBeNull();
    });
  });

  describe("Start all and the live progress of every server", () => {
    const plan = [
      { sourceServerRef: "a", kind: "in-place" as const, targetServerId: "srv-a", topology: "swap-proxy" as const, wave: 0 },
      { sourceServerRef: "b", kind: "in-place" as const, targetServerId: "srv-b", topology: "swap-proxy" as const, wave: 1 },
    ];
    const camp = (over: Record<string, unknown> = {}) => ({ id: "camp1", teamId: "t1", label: "wave-1", sessionId: "s1", status: "draft" as const, plan, runIds: ["run-aaaa1111", "run-bbbb2222"], driving: false, createdAt: "2026-11-24T08:00:00.000Z", ...over });
    const NOT_APPLICABLE = ["DNS_PREPARE", "DATA_SEED", "FREEZE", "DATA_FINAL", "TLS_PREISSUE"];
    /** The 13 steps of an in-place run as the hub makes them: the five that copy nothing are skipped. */
    const steps = (status: Partial<Record<MigrationRunStepKey, MigrationRunStepView["status"]>>, over: Partial<Record<MigrationRunStepKey, Partial<MigrationRunStepView>>> = {}) =>
      MIGRATION_RUN_STEP_KEYS.filter((k) => k !== "DECOMMISSION").map((k) => mkStep(k, NOT_APPLICABLE.includes(k) ? "SKIPPED" : (status[k] ?? "PENDING"), over[k] ?? {}));
    const view = (id: string, target: string, name: string, over: Partial<MigrationRunView> = {}) => mkRun({ id, targetServerId: target, targetServerName: name, campaign: "wave-1", inPlace: true, topology: "swap-proxy", ...over });
    const approvalNext = { kind: "approval" as const, stepKey: "VERIFY" as const, code: "verify.review", since: "2026-11-24T10:00:00.000Z", approval: binding({ confirm: "target-server" }) };
    const waiting = (id: string, target: string, name: string) =>
      view(id, target, name, { status: "WAITING", currentStep: "VERIFY", nextAction: approvalNext, steps: steps({ PREFLIGHT: "PASSED", IMPORT: "PASSED", REMAP_ENV: "PASSED", DEPLOY_DARK: "PASSED", VERIFY: "WAITING_APPROVAL" }) });
    const queued = (id: string, target: string, name: string) => view(id, target, name, { status: "QUEUED", currentStep: null, steps: steps({}), nextAction: { kind: "none", stepKey: null, code: "run.queued", since: "2026-11-24T10:00:00.000Z" }, allowed: { ...mkRun().allowed, start: true } });
    const summaries = (a: Partial<MigrationRunSummary>, b: Partial<MigrationRunSummary>) => [
      mkSummary({ id: "run-aaaa1111", campaign: "wave-1", targetServerId: "srv-a", targetServerName: "Olgu Server", inPlace: true, topology: "swap-proxy", createdAt: "2026-11-24T09:00:00.000Z", ...a }),
      mkSummary({ id: "run-bbbb2222", campaign: "wave-1", targetServerId: "srv-b", targetServerName: "Section Server", inPlace: true, topology: "swap-proxy", createdAt: "2026-11-24T10:00:00.000Z", ...b }),
    ];
    const setup = (views: Record<string, MigrationRunView>, sums: MigrationRunSummary[], campaigns = [camp()]) => {
      vi.mocked(api.listMigrationRuns).mockResolvedValue(sums);
      vi.mocked(api.listCampaigns).mockResolvedValue(campaigns);
      vi.mocked(api.getMigrationRunReport).mockRejectedValue(new Error("no report"));
      vi.spyOn(api, "getMigrationRun").mockImplementation(async (id: string) => views[id]);
    };

    it("queued servers: one clear button hands the campaign to the hub, nothing else to press", async () => {
      setup({ "run-aaaa1111": queued("run-aaaa1111", "srv-a", "Olgu Server"), "run-bbbb2222": queued("run-bbbb2222", "srv-b", "Section Server") }, summaries({ status: "QUEUED", currentStep: null }, { status: "QUEUED", currentStep: null }));
      const start = vi.spyOn(api, "startCampaign").mockResolvedValue(camp({ driving: true }));
      wrap();
      const btn = await screen.findByRole("button", { name: "Start moving 2 servers" });
      expect(screen.getByTestId("campaign-headline").getAttribute("data-kind")).toBe("ready");
      expect(screen.getAllByText("Not started")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: /Pause/ })).toBeNull();
      fireEvent.click(btn);
      await waitFor(() => expect(start).toHaveBeenCalledWith("camp1"));
      expect(start).toHaveBeenCalledTimes(1);
    });

    it("while the hub drives it there is no start button, only a way to hold back the servers that have not started", async () => {
      setup({ "run-aaaa1111": queued("run-aaaa1111", "srv-a", "Olgu Server"), "run-bbbb2222": queued("run-bbbb2222", "srv-b", "Section Server") }, summaries({ status: "RUNNING", currentStep: "PREFLIGHT" }, { status: "QUEUED", currentStep: null }), [camp({ driving: true, status: "running" })]);
      const pause = vi.spyOn(api, "pauseCampaign").mockResolvedValue(camp({ driving: false }));
      wrap();
      const btn = await screen.findByRole("button", { name: "Pause starting new servers" });
      expect(screen.queryByRole("button", { name: /Start moving/ })).toBeNull();
      fireEvent.click(btn);
      await waitFor(() => expect(pause).toHaveBeenCalledWith("camp1"));
    });

    it("a paused campaign says so and offers Continue", async () => {
      setup({ "run-aaaa1111": view("run-aaaa1111", "srv-a", "Olgu Server", { status: "COMPLETED", currentStep: null }), "run-bbbb2222": queued("run-bbbb2222", "srv-b", "Section Server") }, summaries({ status: "COMPLETED", currentStep: null }, { status: "QUEUED", currentStep: null }), [camp({ driving: false, status: "paused" })]);
      wrap();
      await screen.findByRole("button", { name: "Continue" });
      expect(screen.getByTestId("campaign-headline").getAttribute("data-kind")).toBe("paused");
    });

    it("each server shows only the steps that apply to an in-place move, with the step it is on in words", async () => {
      setup({ "run-aaaa1111": waiting("run-aaaa1111", "srv-a", "Olgu Server"), "run-bbbb2222": queued("run-bbbb2222", "srv-b", "Section Server") }, summaries({ status: "WAITING", currentStep: "VERIFY", nextActionKind: "approval" }, { status: "QUEUED", currentStep: null }), [camp({ driving: true, status: "running" })]);
      wrap();
      const row = (await screen.findAllByTestId("wave-row"))[0];
      await waitFor(() => expect(within(row).getByTestId("mini-steps")).toBeTruthy());
      const marks = within(row).getByTestId("mini-steps").querySelectorAll("li");
      expect(marks).toHaveLength(8);
      expect([...marks].map((m) => m.getAttribute("data-step"))).toEqual(["PREFLIGHT", "IMPORT", "REMAP_ENV", "DEPLOY_DARK", "VERIFY", "CUTOVER", "OBSERVE", "FINALIZE"]);
      expect(within(row).queryByText(/Freeze the source/)).toBeNull();
      expect(within(row).getAllByText(/Needs you/).length).toBeGreaterThanOrEqual(1);
      expect(within(row).getByText(/4 of 8 steps/)).toBeTruthy();
      // in place there is no copy badge and no window or move counters
      expect(within(row).queryByText("Copy")).toBeNull();
      expect(within(row).queryByText(/Window/)).toBeNull();
      expect(within(row).queryByText(/not cut over/)).toBeNull();
    });

    it("an approval is a clear 'Needs you' item with the review and Approve right there", async () => {
      setup({ "run-aaaa1111": waiting("run-aaaa1111", "srv-a", "Olgu Server"), "run-bbbb2222": queued("run-bbbb2222", "srv-b", "Section Server") }, summaries({ status: "WAITING", currentStep: "VERIFY", nextActionKind: "approval" }, { status: "QUEUED", currentStep: null }), [camp({ driving: true, status: "running" })]);
      wrap();
      const item = await screen.findByTestId("needs-you-item");
      expect(within(item).getByText("Approve the check of Olgu Server")).toBeTruthy();
      expect(screen.getByTestId("campaign-headline").getAttribute("data-kind")).toBe("needs");
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      fireEvent.click(within(item).getByRole("button", { name: "Review and approve" }));
      expect(await within(item).findByRole("button", { name: "Approve" })).toBeTruthy();
      expect(within(item).getByLabelText("Type Olgu Server to confirm")).toBeTruthy();
    });

    it("an approval waits its turn while another server of the campaign is switching", async () => {
      const switching = view("run-aaaa1111", "srv-a", "Olgu Server", { status: "RUNNING", currentStep: "CUTOVER", steps: steps({ PREFLIGHT: "PASSED", IMPORT: "PASSED", REMAP_ENV: "PASSED", DEPLOY_DARK: "PASSED", VERIFY: "PASSED", CUTOVER: "RUNNING" }) });
      setup({ "run-aaaa1111": switching, "run-bbbb2222": waiting("run-bbbb2222", "srv-b", "Section Server") }, summaries({ status: "RUNNING", currentStep: "CUTOVER" }, { status: "WAITING", currentStep: "VERIFY", nextActionKind: "approval" }), [camp({ driving: true, status: "running" })]);
      wrap();
      const item = await screen.findByTestId("needs-you-item");
      expect(within(item).getByText(/Another server is switching now/)).toBeTruthy();
      expect(within(item).queryByRole("button", { name: "Review and approve" })).toBeNull();
    });

    it("a failed server stops the line in plain words and points at it", async () => {
      const failed = view("run-aaaa1111", "srv-a", "Olgu Server", { status: "FAILED", currentStep: "DEPLOY_DARK", nextAction: { kind: "failed", stepKey: "DEPLOY_DARK", code: "step.failed", since: "2026-11-24T10:00:00.000Z" }, steps: steps({ PREFLIGHT: "PASSED", IMPORT: "PASSED", REMAP_ENV: "PASSED", DEPLOY_DARK: "FAILED" }) });
      setup({ "run-aaaa1111": failed, "run-bbbb2222": queued("run-bbbb2222", "srv-b", "Section Server") }, summaries({ status: "FAILED", currentStep: "DEPLOY_DARK", failure: { step: "DEPLOY_DARK", code: "deploy-dark.failed" } }, { status: "QUEUED", currentStep: null }), [camp({ driving: true, status: "paused" })]);
      wrap();
      await screen.findByText("Stopped: Olgu Server needs attention");
      expect(screen.getByTestId("campaign-headline").getAttribute("data-kind")).toBe("failed");
      expect(screen.getAllByRole("link", { name: "Open the run" })[0].getAttribute("href")).toBe("/import/runs/run-aaaa1111");
    });

    it("a finished move says so, with nothing left to press", async () => {
      setup({ "run-aaaa1111": view("run-aaaa1111", "srv-a", "Olgu Server", { status: "COMPLETED", currentStep: null }), "run-bbbb2222": view("run-bbbb2222", "srv-b", "Section Server", { status: "COMPLETED", currentStep: null }) }, summaries({ status: "COMPLETED", currentStep: null }, { status: "COMPLETED", currentStep: null }), [camp({ status: "done" })]);
      wrap();
      await screen.findByText("Move finished");
      expect(screen.queryByRole("button", { name: /Start moving|Continue|Pause/ })).toBeNull();
      // nothing failed: no failures card
      expect(screen.queryByText("What failed or was not cut over")).toBeNull();
    });
  });
});
