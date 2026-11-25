import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { CampaignView, MoveOffServerRow, MoveOffStatusView } from "@tugra/shared";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import { CoolifyMoveChecklist } from "./coolify-move-checklist";
import { CampaignReportList, TeamCampaignReportList } from "./campaign-report-list";

afterEach(cleanup);

const row = (o: Partial<MoveOffServerRow>): MoveOffServerRow => ({ serverId: "s1", name: "box", agentOnline: true, coolify: true, isCoolifyHub: false, takeover: "none", cleanup: "none", stage: "takeover", ...o });
const view = (o: Partial<MoveOffStatusView> = {}): MoveOffStatusView => ({
  teamId: "t1",
  hub: { serverId: "hub", name: "coolify-hub", readAt: new Date(Date.now() - 60_000).toISOString(), knownServers: 4, unlinkedServers: 0, secrets: "active", secretsExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), ssh: { runId: "r", finished: true, online: 2, failed: 0, skipped: 0, pending: 0, total: 2 } },
  servers: [
    row({ serverId: "a", name: "alpha", stage: "done", takeover: "VERIFIED", cleanup: "CLEANED" }),
    row({ serverId: "b", name: "bravo", stage: "cleanup", takeover: "VERIFIED" }),
    row({ serverId: "c", name: "charlie", stage: "takeover" }),
    row({ serverId: "d", name: "delta", stage: "agent", agentOnline: false }),
    row({ serverId: "hub", name: "coolify-hub", stage: "hub", isCoolifyHub: true }),
    row({ serverId: "x", name: "other", stage: "not_coolify", coolify: false }),
  ],
  campaigns: [],
  projectMoves: { total: 0, active: 0, completed: 0, failed: 0, latestPhase: null },
  steps: [
    { step: "takeover", done: 2, total: 4, complete: false },
    { step: "cleanup", done: 1, total: 4, complete: false },
    { step: "consolidate", done: 0, total: 0, complete: false },
    { step: "shutdown", done: 0, total: 1, complete: false },
  ],
  ...o,
});
const campaign = (o: Partial<CampaignView> = {}): CampaignView => ({ id: "c1", label: "wave 1", sessionId: null, status: "running", plan: [], runIds: ["r1", "r2"], createdAt: new Date(Date.now() - 3_600_000).toISOString(), ...o });

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
  vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "OWNER" }]);
  vi.spyOn(api, "listCampaigns").mockResolvedValue([]);
});
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={qc}><I18nProvider>{ui}</I18nProvider></QueryClientProvider>);

describe("CoolifyMoveChecklist", () => {
  it("walks the four steps A to D with a count for each and marks the one to work on", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("step-takeover");
    for (const [id, title] of [["takeover", "A. Take over in place"], ["cleanup", "B. Clean up Coolify"], ["consolidate", "C. Consolidate projects"], ["shutdown", "D. Shut down Coolify"]]) {
      expect(within(screen.getByTestId(`step-${id}`)).getByText(title)).toBeTruthy();
    }
    expect(within(screen.getByTestId("step-takeover")).getByText("2 of 4")).toBeTruthy();
    expect(within(screen.getByTestId("step-cleanup")).getByText("1 of 4")).toBeTruthy();
    expect(within(screen.getByTestId("step-consolidate")).getByText("Optional")).toBeTruthy();
    expect(screen.getByTestId("step-takeover").getAttribute("data-current")).toBe("true");
    expect(screen.getByTestId("step-cleanup").getAttribute("data-current")).toBe("false");
    expect(screen.getByTestId("overall").textContent).toBe("1 of 4 Coolify servers are cleaned off");
  });

  it("lists every Coolify server per step with its status and the screen to press the button on; the hub and unrelated servers are not rows", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("step-takeover");
    expect(screen.queryByTestId("row-takeover-hub")).toBeNull();
    expect(screen.queryByTestId("row-takeover-x")).toBeNull();
    // An offline agent comes first and says so; a server not yet taken over goes to Import; a taken-over one is done in step A.
    const rows = screen.getAllByTestId(/^row-takeover-/).map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual(["row-takeover-d", "row-takeover-c", "row-takeover-b", "row-takeover-a"]);
    expect(within(screen.getByTestId("row-takeover-d")).getByText("Offline")).toBeTruthy();
    expect(within(screen.getByTestId("row-takeover-d")).getByRole("link", { name: "Open server" }).getAttribute("href")).toBe("/servers/d");
    expect(within(screen.getByTestId("row-takeover-c")).getByRole("link", { name: "Start from Import" }).getAttribute("href")).toBe("/import");
    expect(within(screen.getByTestId("row-takeover-b")).getByText("Complete")).toBeTruthy();
    // Step B: a server not yet taken over waits for step A; one taken over offers the cleanup; a cleaned one is done.
    expect(within(screen.getByTestId("row-cleanup-c")).queryByRole("link", { name: "Clean up" })).toBeNull();
    expect(within(screen.getByTestId("row-cleanup-b")).getByRole("link", { name: "Clean up" }).getAttribute("href")).toBe("/servers/b");
    expect(within(screen.getByTestId("row-cleanup-a")).getByText("Cleaned")).toBeTruthy();
  });

  it("before the move starts it says where Coolify stands: read, agents, consent", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
    wrap(<CoolifyMoveChecklist />);
    const lines = await screen.findByTestId("prelude-lines");
    expect(lines.textContent).toMatch(/Read 1 minute ago|Read .* 4 servers known/);
    expect(lines.textContent).toMatch(/2 of 2 online, 0 failed, 0 in progress/);
    expect(lines.textContent).toMatch(/Allowed until/);
  });

  it("says how many of Coolify's servers are not matched yet and links to the host page, and says nothing when all are matched", async () => {
    const v = view();
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue({ ...v, hub: { ...v.hub!, unlinkedServers: 23 } });
    wrap(<CoolifyMoveChecklist />);
    const li = await screen.findByTestId("unlinked-servers");
    expect(li.textContent).toMatch(/23 of Coolify's servers are not matched/);
    expect(within(li).getByRole("link", { name: "Match servers" }).getAttribute("href")).toBe("/import/coolify-host?server=hub");
    cleanup();
    qc.clear();
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("prelude-lines");
    expect(screen.queryByTestId("unlinked-servers")).toBeNull();
  });

  it("with no Coolify host connected it offers to connect one", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view({ hub: null, servers: [], steps: view().steps.map((s) => ({ ...s, total: 0, done: 0 })) }));
    wrap(<CoolifyMoveChecklist />);
    await screen.findByText("No Coolify host is connected yet.");
    expect(screen.getByRole("link", { name: "Connect Coolify" }).getAttribute("href")).toBe("/import/coolify-host");
    expect(screen.getByTestId("shutdown-state").textContent).toBe("Connect the Coolify host first.");
  });

  it("shutdown says how many servers still need work, and is ready only when all are cleaned", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("step-shutdown");
    expect(screen.getByTestId("shutdown-state").textContent).toBe("Not yet. 3 servers still need work.");
    cleanup();
    qc.clear();
    const done = view({ servers: [row({ serverId: "a", name: "alpha", stage: "done", cleanup: "CLEANED", takeover: "VERIFIED" })], steps: view().steps.map((s) => (s.step === "takeover" || s.step === "cleanup" ? { ...s, done: 1, total: 1, complete: true } : s)) });
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(done);
    wrap(<CoolifyMoveChecklist />);
    await waitFor(() => expect(screen.getByTestId("shutdown-state").textContent).toBe("Every Coolify server is cleaned off. You can now shut Coolify down."));
    expect(screen.getByTestId("step-shutdown").getAttribute("data-current")).toBe("true");
  });

  it("a running or failed project move keeps step C from completing and shows the counts", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view({ projectMoves: { total: 3, active: 1, completed: 1, failed: 1, latestPhase: "MOVING" }, steps: view().steps.map((s) => (s.step === "consolidate" ? { ...s, done: 1, total: 3 } : s)) }));
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("step-consolidate");
    expect(within(screen.getByTestId("step-consolidate")).getByText("3 moves: 1 completed, 1 running, 1 failed")).toBeTruthy();
    expect(within(screen.getByTestId("step-consolidate")).getByText("1 of 3")).toBeTruthy();
  });

  it("a member who is not an owner or admin is told so and nothing is asked of the hub", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team", role: "VIEWER" }]);
    const spy = vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
    wrap(<CoolifyMoveChecklist />);
    await screen.findByText("Only a team owner or admin can see this.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a refused status shows the permission line and a failed one a retry line, never the response text", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockRejectedValue(new ApiError(403, "RESPONSE-TEXT"));
    wrap(<CoolifyMoveChecklist />);
    await screen.findByText("Only a team owner or admin can see this.");
    cleanup();
    qc.clear();
    vi.spyOn(api, "coolifyMoveStatus").mockRejectedValue(new ApiError(500, "RESPONSE-TEXT"));
    wrap(<CoolifyMoveChecklist />);
    await screen.findByText("Could not load the progress. Try again in a moment.");
    expect(document.body.textContent).not.toContain("RESPONSE-TEXT");
  });
});

describe("CampaignReportList", () => {
  it("lists each campaign with its status, run count and a link to its report", async () => {
    vi.spyOn(api, "listCampaigns").mockResolvedValue([campaign(), campaign({ id: "c2", label: "a&b", status: "done", runIds: [] })]);
    wrap(<CampaignReportList teamId="t1" />);
    const list = await screen.findByTestId("campaign-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Running")).toBeTruthy();
    expect(within(items[0]).getByText("2 runs")).toBeTruthy();
    expect(within(items[0]).getByRole("link", { name: "Open report" }).getAttribute("href")).toBe("/import/runs/campaign?c=wave%201");
    expect(within(items[1]).getByRole("link", { name: "Open report" }).getAttribute("href")).toBe("/import/runs/campaign?c=a%26b");
  });

  it("says so when there is no campaign and when the list cannot be read", async () => {
    wrap(<CampaignReportList teamId="t1" />);
    await screen.findByTestId("campaigns-none");
    cleanup();
    qc.clear();
    vi.spyOn(api, "listCampaigns").mockRejectedValue(new ApiError(403, "x"));
    wrap(<CampaignReportList teamId="t1" />);
    await screen.findByText("Could not load the campaigns.");
  });

  it("TeamCampaignReportList asks for the first team the person owns or administers, and nothing for a member", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "tv", name: "V", role: "VIEWER" }, { id: "ta", name: "A", role: "ADMIN" }]);
    const spy = vi.spyOn(api, "listCampaigns").mockResolvedValue([]);
    wrap(<TeamCampaignReportList />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("ta"));
    cleanup();
    spy.mockClear();
    qc.clear();
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "tv", name: "V", role: "VIEWER" }]);
    const { container } = wrap(<TeamCampaignReportList />);
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});
