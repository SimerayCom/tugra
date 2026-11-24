import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ImportScopeStep } from "./import-scope-step";
import type { ImportScope, ScopeSelection } from "../lib/import-scope";
import type { ImportPlan, ImportPlanItem } from "../lib/types";

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
const servers = [
  { id: "t1", name: "Target A", teamId: "team1" },
  { id: "t2", name: "Target B", teamId: "team1" },
];
const teams = [{ id: "team1", name: "Team One", role: "OWNER" }] as never;

const mount = (over: { servers?: typeof servers; teams?: never; onContinue?: (s: ImportScope) => void; plan?: ImportPlan; initial?: ScopeSelection } = {}) =>
  render(
    <I18nProvider>
      <ImportScopeStep initial={over.initial} plan={over.plan ?? plan} servers={over.servers ?? servers} teams={over.teams ?? teams} onContinue={over.onContinue ?? (() => undefined)} onStartOver={() => undefined} />
    </I18nProvider>,
  );

describe("ImportScopeStep", () => {
  it("asks 'What are you moving?' with a server, projects or everything; several servers open on 'A server' with nothing picked", () => {
    mount();
    expect(screen.getByText("What are you moving?")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^A server/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /^Projects/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Everything/ })).toBeTruthy();
    expect(screen.getByText("Pick at least one to continue.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("picking one source server selects its items and maps it to a Tugra server on the same screen", () => {
    const onContinue = vi.fn();
    mount({ onContinue });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box Two/ }));
    expect(screen.getByText("1 apps, 1 databases and 0 services will move.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Box Two moves to"), { target: { value: "t2" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const scope = onContinue.mock.calls[0][0] as ImportScope;
    expect([...scope.inScope].sort()).toEqual(["app:s2:api", "database:s2:apidb"]);
    expect(scope.narrowed).toBe(true);
    expect(scope.defaultServerId).toBe("t2");
    expect(scope.serverMap).toBeUndefined();
  });

  it("two source servers on two Tugra servers produce a serverMap", () => {
    const onContinue = vi.fn();
    mount({ onContinue });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Box Two/ }));
    fireEvent.change(screen.getByLabelText("Box Two moves to"), { target: { value: "t2" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((onContinue.mock.calls[0][0] as ImportScope).serverMap).toEqual({ s1: "t1", s2: "t2" });
  });

  it("projects: pick one, the database it needs from another project is offered with one click", () => {
    const onContinue = vi.fn();
    mount({ onContinue });
    fireEvent.click(screen.getByRole("radio", { name: /^Projects/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Beta/ }));
    expect(screen.getByText("Needed by what you picked: db.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add them" }));
    expect(screen.queryByText(/Needed by what you picked/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const scope = onContinue.mock.calls[0][0] as ImportScope;
    expect([...scope.inScope].sort()).toEqual(["app:s2:api", "database:s1:db", "database:s2:apidb"]);
  });

  it("Everything continues with the whole source and no narrowing", () => {
    const onContinue = vi.fn();
    mount({ onContinue });
    fireEvent.click(screen.getByRole("radio", { name: /^Everything/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const scope = onContinue.mock.calls[0][0] as ImportScope;
    expect(scope.narrowed).toBe(false);
    expect(scope.inScope.size).toBe(4);
  });

  it("a team picker shows only when the servers you can write to span several teams, and limits the targets to that team", () => {
    const multi = [...servers, { id: "t3", name: "Target C", teamId: "team2" }];
    const twoTeams = [{ id: "team1", name: "Team One" }, { id: "team2", name: "Team Two" }] as never;
    mount({ servers: multi, teams: twoTeams });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    const team = screen.getByLabelText("Team");
    fireEvent.change(team, { target: { value: "team2" } });
    expect(screen.getByText("Moves to Target C.")).toBeTruthy();
  });

  it("reopening the step restores the picked team", () => {
    const multi = [...servers, { id: "t3", name: "Target C", teamId: "team2" }];
    const twoTeams = [{ id: "team1", name: "Team One" }, { id: "team2", name: "Team Two" }] as never;
    let got: ImportScope | undefined;
    const first = mount({ servers: multi, teams: twoTeams, onContinue: (s) => (got = s) });
    fireEvent.click(screen.getByRole("checkbox", { name: /Box One/ }));
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team2" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(got?.selection.teamId).toBe("team2");
    first.unmount();
    mount({ servers: multi, teams: twoTeams, initial: got!.selection });
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
    expect(screen.getByRole("alert").textContent).toMatch(/No server you can write to/);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists what each source server holds, short", () => {
    mount();
    const row = screen.getByRole("checkbox", { name: /Box One/ }).closest("label")!;
    expect(within(row).getByText("1 apps · 1 databases · 0 services")).toBeTruthy();
  });
});
