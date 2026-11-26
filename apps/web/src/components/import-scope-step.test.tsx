import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ImportScopeStep } from "./import-scope-step";
import type { ImportScope, ScopeSelection } from "../lib/import-scope";
import type { ImportPlan, ImportPlanItem, ImportTugraMatch } from "../lib/types";

afterEach(cleanup);

const item = (itemRef: string, kind: ImportPlanItem["kind"], name: string, dependsOn: string[] = []): ImportPlanItem => ({ itemRef, kind, name, proposed: {}, risks: [], dependsOn });
const plan: ImportPlan = {
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: [],
  totals: { apps: 2, databases: 2, volumes: 0, blockers: 0 },
  items: [
    item("app:s1:web", "app", "web", ["database:s1:db"]),
    item("database:s1:db", "database", "db"),
    item("app:s2:api", "app", "api", ["database:s2:apidb", "database:s1:db"]),
    item("database:s2:apidb", "database", "apidb"),
  ],
  preflight: {
    databases: [],
    services: [],
    appsWithVolumeData: 0,
    hosts: [{ ref: "s1", name: "Box One" }, { ref: "s2", name: "Box Two" }],
    projects: [
      { ref: "p-acme", name: "Acme", itemRefs: ["app:s1:web", "database:s1:db"] },
      { ref: "p-beta", name: "Beta", itemRefs: ["app:s2:api", "database:s2:apidb"] },
    ],
  },
};
type Srv = { id: string; name: string; teamId: string; status?: string; capabilities?: string[] };
const servers: Srv[] = [
  { id: "t1", name: "Target A", teamId: "team1", status: "ONLINE", capabilities: ["deploy"] },
  { id: "t2", name: "Target B", teamId: "team1", status: "ONLINE", capabilities: ["deploy"] },
];
const hit = (serverId: string, name: string, over: Partial<ImportTugraMatch> = {}): ImportTugraMatch => ({ serverId, name, teamId: "team1", via: "public-ip", confidence: "certain", ...over });
/** The same plan after the hub matched the source servers to registered Tugra servers. */
const withMatches = (hosts: Array<{ ref: string; name: string; tugra?: ImportTugraMatch; controlPlane?: true }>, over: Partial<ImportPlan> = {}): ImportPlan => ({ ...plan, ...over, preflight: { ...plan.preflight!, hosts, ...(over.preflight ?? {}) } });
const teams = [{ id: "team1", name: "Team One", role: "OWNER" }] as never;

const mount = (over: { servers?: Srv[]; teams?: never; onContinue?: (s: ImportScope) => void; plan?: ImportPlan; initial?: ScopeSelection; onRecheck?: () => void } = {}) =>
  render(
    <I18nProvider>
      <ImportScopeStep initial={over.initial} plan={over.plan ?? plan} servers={over.servers ?? servers} teams={over.teams ?? teams} onContinue={over.onContinue ?? (() => undefined)} onStartOver={() => undefined} onRecheck={over.onRecheck} />
    </I18nProvider>,
  );
const continueBtn = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;

describe("ImportScopeStep", () => {
  it("asks 'What are you moving?'; several unmatched servers open on 'A server' with nothing picked and nothing chosen for the user", () => {
    mount();
    expect(screen.getByText("What are you moving?")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^A server/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /^Projects/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Everything/ })).toBeTruthy();
    expect(screen.getByText("Pick at least one to continue.")).toBeTruthy();
    expect(continueBtn().disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Box One/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("a picked source server has NO target until one is chosen: no first-server default, Continue says what is missing", () => {
    const onContinue = vi.fn();
    mount({ onContinue });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box Two/ }));
    expect(screen.getByText("Choose a server for: Box Two.")).toBeTruthy();
    const select = screen.getByLabelText("Box Two moves to") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(within(select).getByRole("option", { name: "Choose a server" })).toBeTruthy();
    expect(continueBtn().disabled).toBe(true);
    fireEvent.change(select, { target: { value: "t2" } });
    expect(screen.getByText("1 apps, 1 databases and 0 services will move.")).toBeTruthy();
    expect(screen.getByText("Another server.")).toBeTruthy();
    fireEvent.click(continueBtn());
    const scope = onContinue.mock.calls[0][0] as ImportScope;
    expect([...scope.inScope].sort()).toEqual(["app:s2:api", "database:s2:apidb"]);
    expect(scope.narrowed).toBe(true);
    expect(scope.defaultServerId).toBe("t2");
    expect(scope.serverMap).toBeUndefined();
    expect(scope.placementKind).toEqual({ s2: "other-server" });
  });

  it("two source servers on two Tugra servers produce a serverMap, each needing its own pick", () => {
    const onContinue = vi.fn();
    mount({ onContinue });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Box Two/ }));
    fireEvent.change(screen.getByLabelText("Box One moves to"), { target: { value: "t1" } });
    expect(continueBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Box Two moves to"), { target: { value: "t2" } });
    fireEvent.click(continueBtn());
    expect((onContinue.mock.calls[0][0] as ImportScope).serverMap).toEqual({ s1: "t1", s2: "t2" });
  });

  it("servers the hub matched by a public address are already ticked and go onto their own machine, labelled 'Same machine (in place)'", () => {
    const onContinue = vi.fn();
    const p = withMatches([{ ref: "s1", name: "Box One", tugra: hit("t1", "Target A") }, { ref: "s2", name: "Box Two" }]);
    mount({ plan: p, onContinue });
    expect(screen.getByText("1 of 2 source servers are already connected to Tugra.")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Box One/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Box Two/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Box One moves to") as HTMLSelectElement).value).toBe("t1");
    expect(screen.getByText("Same machine (in place).")).toBeTruthy();
    expect(screen.getByText(/proxy is swapped, a few minutes of downtime/)).toBeTruthy();
    fireEvent.click(continueBtn());
    const scope = onContinue.mock.calls[0][0] as ImportScope;
    expect(scope.placementKind).toEqual({ s1: "in-place" });
    expect(scope.defaultServerId).toBe("t1");
  });

  it("choosing another server for a matched one says 'Another server'; mixing it with a same-machine move is allowed and explained as a campaign", () => {
    const p = withMatches([{ ref: "s1", name: "Box One", tugra: hit("t1", "Target A") }, { ref: "s2", name: "Box Two", tugra: hit("t2", "Target B") }]);
    mount({ plan: p });
    expect((screen.getByRole("checkbox", { name: /Box Two/ }) as HTMLInputElement).checked).toBe(true);
    expect(continueBtn().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Box Two moves to"), { target: { value: "t1" } });
    expect(screen.getByText(/This is a campaign/)).toBeTruthy();
    expect(screen.queryByText(/cannot go together/)).toBeNull();
    expect(continueBtn().disabled).toBe(false);
  });

  it("a source server not registered in Tugra says so and offers to add it, with its name and team prefilled", () => {
    mount();
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    const link = screen.getByRole("link", { name: "Add this server" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/servers/new?name=Box%20One&team=team1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getAllByText(/Not connected to Tugra yet/).length).toBeGreaterThan(0);
  });

  it("'Check again' reads the servers and the plan again", () => {
    const onRecheck = vi.fn();
    mount({ onRecheck });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRecheck).toHaveBeenCalled();
  });

  it("a probable match (only a private range or a host name) is offered, never applied by itself", () => {
    const onContinue = vi.fn();
    const p = withMatches([{ ref: "s1", name: "Box One", tugra: hit("t1", "Target A", { confidence: "probable", via: "reported-ip" }) }, { ref: "s2", name: "Box Two" }]);
    mount({ plan: p, onContinue });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    expect((screen.getByLabelText("Box One moves to") as HTMLSelectElement).value).toBe("");
    expect(continueBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    expect((screen.getByLabelText("Box One moves to") as HTMLSelectElement).value).toBe("t1");
    expect(continueBtn().disabled).toBe(false);
  });

  it("a target that is offline, has no agent or no deploy permission is shown as such and cannot be picked", () => {
    const list: Srv[] = [...servers, { id: "t3", name: "Target C", teamId: "team1", status: "OFFLINE", capabilities: ["deploy"] }, { id: "t4", name: "Target D", teamId: "team1", status: "PENDING", capabilities: ["deploy"] }, { id: "t5", name: "Target E", teamId: "team1", status: "ONLINE", capabilities: ["backup"] }];
    mount({ servers: list });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    const select = screen.getByLabelText("Box One moves to");
    for (const [name, text] of [["t3", "Target C (offline)"], ["t4", "Target D (agent not connected)"], ["t5", "Target E (no deploy permission)"]] as const) {
      const o = within(select).getByRole("option", { name: text }) as HTMLOptionElement;
      expect(o.disabled).toBe(true);
      expect(o.value).toBe(name);
    }
    expect((within(select).getByRole("option", { name: "Target A" }) as HTMLOptionElement).disabled).toBe(false);
  });

  it("a matched server that is offline blocks Continue and says so", () => {
    const list: Srv[] = [{ ...servers[0], status: "OFFLINE" }, servers[1]];
    const p = withMatches([{ ref: "s1", name: "Box One", tugra: hit("t1", "Target A") }, { ref: "s2", name: "Box Two" }]);
    mount({ plan: p, servers: list });
    expect(screen.getByText("Target A is offline.")).toBeTruthy();
    expect(continueBtn().disabled).toBe(true);
  });

  it("the Coolify box itself cannot move in place: its own machine is not offered and nothing is chosen for it", () => {
    const p = withMatches([{ ref: "s1", name: "Box One", tugra: hit("t1", "Target A"), controlPlane: true }, { ref: "s2", name: "Box Two" }]);
    mount({ plan: p });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    expect(screen.getByText(/Coolify itself runs here/)).toBeTruthy();
    const select = screen.getByLabelText("Box One moves to") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect((within(select).getByRole("option", { name: "Target A" }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getAllByText(/Coolify control plane/).length).toBeGreaterThan(0);
  });

  it("a Dokploy source never offers the same machine", () => {
    const p = withMatches([{ ref: "s1", name: "Box One", tugra: hit("t1", "Target A") }, { ref: "s2", name: "Box Two" }], { sourceKind: "dokploy" });
    mount({ plan: p });
    expect((screen.getByRole("checkbox", { name: /Box One/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    expect((within(screen.getByLabelText("Box One moves to")).getByRole("option", { name: "Target A" }) as HTMLOptionElement).disabled).toBe(true);
  });

  it("projects: pick one, the database it needs from another project is offered with one click; only the servers those projects run on are placed", () => {
    const onContinue = vi.fn();
    mount({ onContinue });
    fireEvent.click(screen.getByRole("radio", { name: /^Projects/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Beta/ }));
    expect(screen.getByText("Needed by what you picked: db.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add them" }));
    expect(screen.queryByText(/Needed by what you picked/)).toBeNull();
    // Beta runs on Box Two; its database came from Box One, so both servers need a target and no other
    expect(screen.getByLabelText("Box Two moves to")).toBeTruthy();
    expect(screen.getByLabelText("Box One moves to")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Box Two moves to"), { target: { value: "t2" } });
    fireEvent.change(screen.getByLabelText("Box One moves to"), { target: { value: "t2" } });
    fireEvent.click(continueBtn());
    const scope = onContinue.mock.calls[0][0] as ImportScope;
    expect([...scope.inScope].sort()).toEqual(["app:s2:api", "database:s1:db", "database:s2:apidb"]);
  });

  it("projects: a project on one server places only that server, and the counts follow the pick", () => {
    mount();
    fireEvent.click(screen.getByRole("radio", { name: /^Projects/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Acme/ }));
    expect(screen.queryByLabelText("Box Two moves to")).toBeNull();
    expect(screen.getByLabelText("Box One moves to")).toBeTruthy();
  });

  it("Everything continues with the whole source and no narrowing once every server has a target", () => {
    const onContinue = vi.fn();
    mount({ onContinue });
    fireEvent.click(screen.getByRole("radio", { name: /^Everything/ }));
    expect(continueBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Box One moves to"), { target: { value: "t1" } });
    fireEvent.change(screen.getByLabelText("Box Two moves to"), { target: { value: "t1" } });
    fireEvent.click(continueBtn());
    const scope = onContinue.mock.calls[0][0] as ImportScope;
    expect(scope.narrowed).toBe(false);
    expect(scope.inScope.size).toBe(4);
  });

  it("select all and select connected tick the server list in one click", () => {
    const p = withMatches([{ ref: "s1", name: "Box One", tugra: hit("t1", "Target A") }, { ref: "s2", name: "Box Two" }]);
    mount({ plan: p });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect((screen.getByRole("checkbox", { name: /Box Two/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Select connected (1)" }));
    expect((screen.getByRole("checkbox", { name: /Box One/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Box Two/ }) as HTMLInputElement).checked).toBe(false);
  });

  const multi: Srv[] = [...servers, { id: "t3", name: "Target C", teamId: "team2", status: "ONLINE", capabilities: ["deploy"] }];
  const twoTeams = [{ id: "team1", name: "Team One" }, { id: "team2", name: "Team Two" }] as never;
  /** Another source than Coolify is one run, and a run belongs to one team: its first step still asks for the team. */
  const dokploy: ImportPlan = { ...plan, sourceKind: "dokploy" };

  describe("Coolify: servers of several teams", () => {
    it("the team is not asked: every server of every team is offered, told apart by team", () => {
      mount({ servers: multi, teams: twoTeams });
      fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
      expect(screen.queryByLabelText("Team")).toBeNull();
      const select = screen.getByLabelText("Box One moves to") as HTMLSelectElement;
      expect([...select.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)])).toEqual([
        ["Team One", ["Target A", "Target B"]],
        ["Team Two", ["Target C"]],
      ]);
    });

    it("one team: the servers are a plain list and the team is named", () => {
      mount();
      fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
      expect(screen.getByLabelText("Box One moves to").querySelector("optgroup")).toBeNull();
      expect(screen.getByText("Team: Team One")).toBeTruthy();
    });

    it("servers in two teams continue, and the scope says the move is a campaign over several teams", () => {
      const onContinue = vi.fn();
      mount({ servers: multi, teams: twoTeams, onContinue, initial: { ...emptySel(), mode: "servers", hosts: new Set(["s1", "s2"]), placement: { s1: "t1", s2: "t3" } } });
      expect(screen.getByTestId("multi-team-note").textContent).toContain("2 teams");
      expect(screen.queryByText("Choose servers from one team.")).toBeNull();
      expect(continueBtn().disabled).toBe(false);
      fireEvent.click(continueBtn());
      expect(onContinue.mock.calls[0][0]).toMatchObject({ multiTeam: true, placed: { s1: "t1", s2: "t3" } });
    });

    it("servers in one team are not a multi-team move", () => {
      const onContinue = vi.fn();
      mount({ servers: multi, teams: twoTeams, onContinue, initial: { ...emptySel(), mode: "servers", hosts: new Set(["s1", "s2"]), placement: { s1: "t1", s2: "t2" } } });
      expect(screen.queryByTestId("multi-team-note")).toBeNull();
      fireEvent.click(continueBtn());
      expect(onContinue.mock.calls[0][0].multiTeam).toBeUndefined();
    });

    it("a source server the hub matched to a server of another team goes onto it as it is (the same machine)", () => {
      const p = withMatches([{ ref: "s1", name: "Box One", tugra: hit("t3", "Target C", { teamId: "team2" }) }, { ref: "s2", name: "Box Two" }]);
      mount({ servers: multi, teams: twoTeams, plan: p });
      expect((screen.getByLabelText("Box One moves to") as HTMLSelectElement).value).toBe("t3");
      expect(continueBtn().disabled).toBe(false);
    });
  });

  it("another source: several teams and nothing to go by: the team is asked, never the first one, and Continue waits", () => {
    mount({ servers: multi, teams: twoTeams, plan: dokploy });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    const team = screen.getByLabelText("Team") as HTMLSelectElement;
    expect(team.value).toBe("");
    expect(screen.getByText("Choose the team these go to.")).toBeTruthy();
    expect(continueBtn().disabled).toBe(true);
    fireEvent.change(team, { target: { value: "team2" } });
    const select = screen.getByLabelText("Box One moves to");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a server", "Target C"]);
  });

  it("another source: the team named like the source team is the default", () => {
    const p: ImportPlan = { ...withMatches([{ ref: "s1", name: "Box One" }, { ref: "s2", name: "Box Two" }], { preflight: { sourceTeam: "team two" } as never }), sourceKind: "dokploy" };
    mount({ servers: multi, teams: twoTeams, plan: p });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team2");
    expect(screen.getByText("Source team: team two")).toBeTruthy();
  });

  it("another source: servers in two teams are still refused", () => {
    mount({ servers: multi, teams: twoTeams, plan: dokploy, initial: { ...emptySel(), mode: "servers", hosts: new Set(["s1", "s2"]), placement: { s1: "t1", s2: "t3" }, teamId: "team1" } });
    expect(continueBtn().disabled).toBe(true);
  });

  it("another source: changing the team keeps a pick that is still valid and ignores one that is not", () => {
    const onContinue = vi.fn();
    mount({ servers: multi, teams: twoTeams, plan: dokploy, onContinue, initial: { ...emptySel(), mode: "servers", hosts: new Set(["s1"]), placement: { s1: "t1" }, teamId: "team1" } });
    expect((screen.getByLabelText("Box One moves to") as HTMLSelectElement).value).toBe("t1");
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team2" } });
    expect((screen.getByLabelText("Box One moves to") as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team1" } });
    expect((screen.getByLabelText("Box One moves to") as HTMLSelectElement).value).toBe("t1");
  });

  it("another source: reopening the step restores the picked team", () => {
    let got: ImportScope | undefined;
    const first = mount({ servers: multi, teams: twoTeams, plan: dokploy, onContinue: (s) => (got = s) });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team2" } });
    fireEvent.change(screen.getByLabelText("Box One moves to"), { target: { value: "t3" } });
    fireEvent.click(continueBtn());
    expect(got?.selection.teamId).toBe("team2");
    first.unmount();
    mount({ servers: multi, teams: twoTeams, plan: dokploy, initial: got!.selection });
    expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team2");
  });

  it("one team: no team picker; the team is named, not asked", () => {
    mount();
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    expect(screen.queryByLabelText("Team")).toBeNull();
    expect(screen.getByText("Team: Team One")).toBeTruthy();
  });

  it("no writable server: says so and cannot continue", () => {
    mount({ servers: [] });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    expect(screen.getAllByRole("alert")[0].textContent).toMatch(/No server you can write to/);
    expect(continueBtn().disabled).toBe(true);
  });

  it("lists what each source server holds, short", () => {
    mount();
    const row = screen.getByRole("checkbox", { name: /Box One/ }).closest("label")!;
    expect(within(row).getByText("1 apps · 1 databases · 0 services")).toBeTruthy();
  });

  it("reports every change of the selection so a refresh can restore it", () => {
    const seen: ScopeSelection[] = [];
    render(
      <I18nProvider>
        <ImportScopeStep plan={plan} servers={servers} teams={teams} onContinue={() => undefined} onStartOver={() => undefined} onSelectionChange={(s) => seen.push(s)} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    expect([...seen[seen.length - 1].hosts]).toEqual(["s1"]);
  });
});

function emptySel(): ScopeSelection {
  return { mode: "servers", hosts: new Set(), projects: new Set(), extra: new Set(), placement: {} };
}
