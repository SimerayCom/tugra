import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { mkSummary } from "../../../../components/migration-run/test-fixtures";
import MigrationRunsPage from "./page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
let scope: string | null = null;
vi.mock("../../../../components/team-scope", () => ({ useTeamScope: () => ({ teamId: scope, setTeamId: vi.fn() }) }));

afterEach(cleanup);
let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MigrationRunsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  push.mockReset();
  scope = null;
});
afterEach(() => vi.restoreAllMocks());

describe("migration runs list page", () => {
  it("lists runs with status, mode, progress and what each waits for, and opens one", async () => {
    vi.spyOn(api, "listMigrationRuns").mockResolvedValue([
      mkSummary({ id: "r1", status: "WAITING", currentStep: "VERIFY", nextActionKind: "approval", stepsPassed: 9 }),
      mkSummary({ id: "r2", status: "FAILED", currentStep: "IMPORT", failure: { step: "IMPORT", code: "import.apply-failed" }, dryRun: true, targetServerName: null, targetServerId: "srv9" }),
    ]);
    wrap();
    await screen.findAllByText("coolify.example.org → tugra-1");
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Verify and approve · Your approval")).toBeTruthy();
    expect(screen.getByText("import: apply failed")).toBeTruthy();
    expect(screen.getByText("coolify.example.org → srv9")).toBeTruthy(); // a deleted server reads as its id
    expect(screen.getByText("Dry run")).toBeTruthy();
    expect(screen.getByText("9/13")).toBeTruthy();
    fireEvent.click(screen.getByText("Verify and approve · Your approval"));
    expect(push).toHaveBeenCalledWith("/import/runs/r1");
  });

  it("scopes to the active team", async () => {
    scope = "t2";
    vi.spyOn(api, "listMigrationRuns").mockResolvedValue([mkSummary({ id: "r1", teamId: "t1" }), mkSummary({ id: "r2", teamId: "t2", targetServerName: "other" })]);
    wrap();
    await screen.findByText("coolify.example.org → other");
    expect(screen.queryByText("coolify.example.org → tugra-1")).toBeNull();
  });

  it("filters to live runs through the hub's `active` flag", async () => {
    const list = vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
    wrap();
    await screen.findByText("No guided migrations yet");
    fireEvent.click(screen.getByRole("checkbox", { name: "Only runs that are still live" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ active: true, limit: 100 }));
  });

  it("an empty list points to the import wizard; an error shows the retry state", async () => {
    vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
    wrap();
    await screen.findByText("No guided migrations yet");
    expect(screen.getAllByRole("link", { name: "Run guided migration" })[0].getAttribute("href")).toBe("/import");
    cleanup();
    vi.restoreAllMocks();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listMigrationRuns").mockRejectedValue(new Error("down"));
    wrap();
    await screen.findByText("Something went wrong");
  });

  it("shows multi-host runs, campaigns and versions, rolls a campaign up and filters by it", async () => {
    const list = vi.spyOn(api, "listMigrationRuns").mockResolvedValue([
      mkSummary({ id: "r1", targetServerCount: 3, campaign: "wave-1", sourceVersion: "4.5.0", status: "COMPLETED" }),
      mkSummary({ id: "r2", campaign: "wave-1", status: "WAITING" }),
    ]);
    wrap();
    await screen.findByText("coolify.example.org → tugra-1 +2");
    expect(screen.getByText("3 target servers")).toBeTruthy();
    expect(screen.getAllByText("Source 4.5.0").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2 runs, 1 completed, 1 still live")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show only the runs of campaign wave-1" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ campaign: "wave-1" })));
  });
});
