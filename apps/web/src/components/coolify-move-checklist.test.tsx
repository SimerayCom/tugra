import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { CampaignView, MoveOffServerRow, MoveOffStatusView } from "@tugra/shared";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import { CoolifyMoveChecklist } from "./coolify-move-checklist";
import { TeamScopeProvider } from "./team-scope";
import { CampaignReportList, TeamCampaignReportList } from "./campaign-report-list";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

afterEach(cleanup);
beforeEach(() => {
  nav.push.mockClear();
  window.sessionStorage.clear();
});

const row = (o: Partial<MoveOffServerRow>): MoveOffServerRow => ({ serverId: "s1", name: "box", agentOnline: true, coolify: true, isCoolifyHub: false, takeover: "none", cleanup: "none", stage: "takeover", ...o });
const view = (o: Partial<MoveOffStatusView> = {}): MoveOffStatusView => ({
  teamId: "t1",
  hub: { serverId: "hub", teamId: "t1", name: "coolify-hub", readAt: new Date(Date.now() - 60_000).toISOString(), knownServers: 4, unlinkedServers: 0, secrets: "active", secretsExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), ssh: { runId: "r", finished: true, online: 2, failed: 0, skipped: 0, pending: 0, total: 2 } },
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
  left: { host: 0, runs: 0 },
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
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={qc}><I18nProvider><TeamScopeProvider>{ui}</TeamScopeProvider></I18nProvider></QueryClientProvider>);

describe("CoolifyMoveChecklist", () => {
  it("the campaign list also reads the other teams the move made a campaign in (one campaign per team)", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view({ campaigns: [{ id: "c1", teamId: "t1", label: "move", status: "running", runs: 1, createdAt: "2026-11-26T10:00:00Z" }, { id: "c2", teamId: "t2", label: "move", status: "draft", runs: 2, createdAt: "2026-11-26T10:00:00Z" }] }));
    const spy = vi.spyOn(api, "listCampaigns").mockResolvedValue([]);
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("step-takeover");
    await waitFor(() => expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(["t1", "t2"]));
  });

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
    expect(within(screen.getByTestId("row-takeover-c")).getByRole("button", { name: "Take over in place" })).toBeTruthy();
    expect(within(screen.getByTestId("row-takeover-d")).queryByRole("button", { name: "Take over in place" })).toBeNull(); // offline agent: bring it back first
    expect(within(screen.getByTestId("row-takeover-b")).queryByRole("button")).toBeNull(); // already taken over
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

  it("shutdown says what is still open, and is ready only when all servers are cleaned, the host is empty and every campaign run is complete", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("step-shutdown");
    expect(screen.getByTestId("shutdown-state").textContent).toContain("Not yet. Still open:");
    expect(screen.getByTestId("shutdown-blocker-servers").textContent).toBe("3 servers still need work in steps A and B.");
    cleanup();
    qc.clear();
    const cleaned = [row({ serverId: "a", name: "alpha", stage: "done", cleanup: "CLEANED", takeover: "VERIFIED" })];
    const stepsDone = view().steps.map((s) => (s.step === "takeover" || s.step === "cleanup" ? { ...s, done: 1, total: 1, complete: true } : s));
    // cleaned servers, but apps still run on the Coolify host and a campaign run is open: never "you can shut Coolify down"
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view({ servers: cleaned, steps: stepsDone, left: { host: 2, runs: 1 } }));
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("shutdown-blocker-host");
    expect(screen.getByTestId("shutdown-blocker-host").textContent).toBe("2 apps, databases or services still run on the Coolify host itself. Copy them to another server first.");
    expect(screen.getByTestId("shutdown-blocker-runs").textContent).toBe("1 campaign runs are not complete yet.");
    expect(screen.getByTestId("shutdown-state").textContent).not.toContain("You can now shut Coolify down");
    cleanup();
    qc.clear();
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view({ servers: cleaned, steps: stepsDone }));
    wrap(<CoolifyMoveChecklist />);
    await waitFor(() => expect(screen.getByTestId("shutdown-state").textContent).toContain("You can now shut Coolify down."));
    expect(screen.getByTestId("step-shutdown").getAttribute("data-current")).toBe("true");
  });

  it("a Coolify host that manages no other server gets its own explanation, not 'connect your host' and not 0 servers", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view({ servers: [row({ serverId: "hub", name: "coolify-hub", stage: "hub", isCoolifyHub: true })], left: { host: 3, runs: 0 }, steps: view().steps.map((s) => ({ ...s, total: 0, done: 0 })) }));
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("step-shutdown");
    expect(screen.getByTestId("no-movers").textContent).toContain("manages no other server");
    expect(screen.queryByText(/Connect your Coolify host first/)).toBeNull();
    expect(screen.getByTestId("shutdown-blocker-host").textContent).toContain("3 apps, databases or services still run on the Coolify host itself");
    expect(screen.getByTestId("shutdown-state").textContent).not.toMatch(/0 servers/);
  });

  it("a running or failed project move keeps step C from completing and shows the counts", async () => {
    vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view({ projectMoves: { total: 3, active: 1, completed: 1, failed: 1, latestPhase: "MOVING" }, steps: view().steps.map((s) => (s.step === "consolidate" ? { ...s, done: 1, total: 3 } : s)) }));
    wrap(<CoolifyMoveChecklist />);
    await screen.findByTestId("step-consolidate");
    expect(within(screen.getByTestId("step-consolidate")).getByText("3 moves: 1 completed, 1 running, 1 failed")).toBeTruthy();
    expect(within(screen.getByTestId("step-consolidate")).getByText("1 of 3")).toBeTruthy();
  });

  describe("Take over in place on a row", () => {
    it("with no guided run it reads Coolify through the agent on the Coolify host and opens the import on that server", async () => {
      vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
      vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
      const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValue({ sessionId: "sess-1234abcd", expiresAt: "x", read: {} } as never);
      wrap(<CoolifyMoveChecklist />);
      await screen.findByTestId("step-takeover");
      fireEvent.click(within(screen.getByTestId("row-takeover-c")).getByRole("button", { name: "Take over in place" }));
      await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/import"));
      expect(connect).toHaveBeenCalledWith({ teamId: "t1", serverId: "hub" });
      expect(JSON.parse(window.sessionStorage.getItem("tugra.import.focus") ?? "{}")).toEqual({ kind: "coolify", agentSessionId: "sess-1234abcd", inPlaceServerId: "c", fromServerName: "charlie" });
    });

    it("with a guided run for that server the row opens the run (it drives the takeover) and makes no session", async () => {
      vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
      vi.spyOn(api, "listMigrationRuns").mockResolvedValue([{ id: "r9", teamId: "t1", targetServerId: "c", topology: "swap-proxy", dryRun: false, status: "WAITING", createdAt: "2026-11-25T00:00:00Z" }] as never);
      const connect = vi.spyOn(api, "importConnectAgent");
      wrap(<CoolifyMoveChecklist />);
      await screen.findByTestId("step-takeover");
      fireEvent.click(within(screen.getByTestId("row-takeover-c")).getByRole("button", { name: "Take over in place" }));
      await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/import/runs/r9"));
      expect(connect).not.toHaveBeenCalled();
    });

    it("says so and links to the Coolify host when reading it is not turned on yet; nothing is opened", async () => {
      vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
      vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
      vi.spyOn(api, "importConnectAgent").mockRejectedValue(new ApiError(409, "RESPONSE-TEXT", "not_enabled"));
      wrap(<CoolifyMoveChecklist />);
      await screen.findByTestId("step-takeover");
      fireEvent.click(within(screen.getByTestId("row-takeover-c")).getByRole("button", { name: "Take over in place" }));
      const alert = await within(screen.getByTestId("row-takeover-c")).findByRole("alert");
      expect(alert.textContent).toMatch(/not turned on yet/);
      expect(within(alert).getByRole("link", { name: "Open the Coolify host" }).getAttribute("href")).toBe("/import/coolify-host?server=hub");
      expect(nav.push).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("RESPONSE-TEXT");
      expect(window.sessionStorage.getItem("tugra.import.focus")).toBeNull();
    });
  });

  describe("per-team progress", () => {
    const teamView = (teamId: string, taken: number, cleaned: number, total: number): MoveOffStatusView => {
      const servers = Array.from({ length: total }, (_, i) => row({ serverId: `${teamId}-${i}`, name: `${teamId}${i}`, stage: i < cleaned ? "done" : i < taken ? "cleanup" : "takeover" }));
      return view({ teamId, servers });
    };
    const twoTeams = () => {
      vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Alpha", role: "OWNER" }, { id: "t2", name: "Beta", role: "ADMIN" }, { id: "t3", name: "Gamma", role: "OWNER" }, { id: "t4", name: "Viewer team", role: "VIEWER" }]);
      return vi.spyOn(api, "coolifyMoveStatus").mockImplementation(async (id: string) => {
        if (id === "t1") return teamView("t1", 3, 1, 4);
        if (id === "t2") return teamView("t2", 2, 2, 2);
        throw new ApiError(403, "no");
      });
    };

    it("shows one line per team that has Coolify, with its taken over and cleaned counts, and the total", async () => {
      const spy = twoTeams();
      wrap(<CoolifyMoveChecklist />);
      const list = await screen.findByTestId("teams-overview");
      await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
      expect(within(screen.getByTestId("team-t1")).getByText("3 of 4 taken over, 1 cleaned")).toBeTruthy();
      expect(within(screen.getByTestId("team-t2")).getByText("2 of 2 taken over, 2 cleaned")).toBeTruthy();
      expect(screen.getByTestId("teams-overview-total").textContent).toBe("All teams: 5 of 6 taken over, 3 cleaned");
      // a team that cannot be read is left out, and a team the person only views is never asked
      expect(screen.queryByTestId("team-t3")).toBeNull();
      expect(spy.mock.calls.map((c) => c[0])).not.toContain("t4");
    });

    it("Show this team switches the steps below to that team; the shown one has no button", async () => {
      twoTeams();
      wrap(<CoolifyMoveChecklist />);
      await screen.findByTestId("team-t2");
      expect(screen.getByTestId("team-t1").getAttribute("data-current")).toBe("true");
      expect(within(screen.getByTestId("team-t1")).queryByRole("button", { name: "Show this team" })).toBeNull();
      fireEvent.click(within(screen.getByTestId("team-t2")).getByRole("button", { name: "Show this team" }));
      await waitFor(() => expect(screen.getByTestId("team-t2").getAttribute("data-current")).toBe("true"));
    });

    it("is not shown for a single team, nor when only one team has Coolify", async () => {
      vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(view());
      wrap(<CoolifyMoveChecklist />);
      await screen.findByTestId("step-takeover");
      expect(screen.queryByTestId("teams-overview")).toBeNull();
      cleanup();
      qc.clear();
      vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Alpha", role: "OWNER" }, { id: "t2", name: "Beta", role: "OWNER" }]);
      vi.spyOn(api, "coolifyMoveStatus").mockImplementation(async (id: string) => (id === "t1" ? view() : view({ teamId: "t2", hub: null, servers: [] })));
      wrap(<CoolifyMoveChecklist />);
      await screen.findByTestId("step-takeover");
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByTestId("teams-overview")).toBeNull();
    });
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
    // the finished one is one tab away: the list opens on what is live
    fireEvent.click(await screen.findByRole("tab", { name: /All/ }));
    const list = await screen.findByTestId("campaign-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // the list is newest first; both fixtures are made "now", so find each line by its label rather than its position
    const wave = items.find((li) => within(li).queryByText("wave 1"))!;
    const ab = items.find((li) => within(li).queryByText("a&b"))!;
    expect(within(wave).getByText("Moving")).toBeTruthy();
    expect(within(wave).getByText("2 runs")).toBeTruthy();
    // the whole row is the link, and it goes by the campaign's id, not its label
    expect(within(wave).getByRole("link").getAttribute("href")).toBe("/import/runs/campaign?id=c1");
    expect(within(ab).getByRole("link").getAttribute("href")).toBe("/import/runs/campaign?id=c2");
  });

  it("the campaigns of several teams under one label are one line: runs added up, the teams counted, the state that needs the owner first", async () => {
    const spy = vi.spyOn(api, "listCampaigns").mockImplementation(async (team: string) =>
      team === "t1" ? [campaign({ id: "c1", teamId: "t1", label: "move", status: "done", runIds: ["r1"] })] : [campaign({ id: "c2", teamId: "t2", label: "move", status: "paused", runIds: ["r2", "r3"] })],
    );
    wrap(<CampaignReportList teamId="t1" extraTeamIds={["t2", "t1"]} />);
    const list = await screen.findByTestId("campaign-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(["t1", "t2"]);
    expect(within(items[0]).getByText("Waiting for you")).toBeTruthy();
    expect(within(items[0]).getByText("3 runs")).toBeTruthy();
    expect(within(items[0]).getByText("2 teams")).toBeTruthy();
    expect(within(items[0]).getByRole("link").getAttribute("href")).toBe("/import/runs/campaign?id=c1");
  });

  it("a team that refuses the list adds nothing; the page team's own failure is the error", async () => {
    vi.spyOn(api, "listCampaigns").mockImplementation(async (team: string) => {
      if (team === "t2") throw new ApiError(403, "x");
      return [campaign()];
    });
    wrap(<CampaignReportList teamId="t1" extraTeamIds={["t2"]} />);
    const list = await screen.findByTestId("campaign-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
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

  it("TeamCampaignReportList reads the teams the person owns or administers (all of them with no team picked), and nothing for a member", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "tv", name: "V", role: "VIEWER" }, { id: "ta", name: "A", role: "ADMIN" }]);
    const spy = vi.spyOn(api, "listCampaigns").mockResolvedValue([]);
    wrap(<TeamCampaignReportList />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("ta"));
    expect(spy).not.toHaveBeenCalledWith("tv");
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
