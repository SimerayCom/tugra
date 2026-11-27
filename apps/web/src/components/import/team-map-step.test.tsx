import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import type { ImportPlan, Team } from "../../lib/types";
import { TeamMapStep } from "./team-map-step";
import { TeamFilterToggle } from "./team-filter-toggle";
import { teamScope } from "../../lib/import-team";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const NORTHWIND = { ref: "1", name: "Northwind" };
const ACME = { ref: "2", name: "Acme" };
const LAB = { ref: "3", name: "Lab" };
const item = (itemRef: string) => ({ itemRef, kind: "app", name: itemRef, proposed: {}, risks: [], dependsOn: [] });
const plan = (teamMap?: Record<string, string | null>): ImportPlan =>
  ({
    sourceKind: "coolify",
    mode: "copy",
    items: [item("app:a:x"), item("app:a:y"), item("app:b:z"), item("app:c:w")],
    totals: { apps: 4, databases: 0, volumes: 0, blockers: 0 },
    warnings: [],
    planHash: "a".repeat(32),
    preflight: {
      databases: [],
      services: [],
      appsWithVolumeData: 0,
      hosts: [{ ref: "a", name: "a", team: NORTHWIND }, { ref: "b", name: "b", team: ACME }, { ref: "c", name: "c", team: LAB }],
      projects: [
        { ref: "p1", name: "Web", itemRefs: ["app:a:x", "app:a:y"], team: NORTHWIND },
        { ref: "p2", name: "Acme web", itemRefs: ["app:b:z"], team: ACME },
        { ref: "p3", name: "Lab", itemRefs: ["app:c:w"], team: LAB },
      ],
      ...(teamMap ? { teamMap } : {}),
    },
  }) as unknown as ImportPlan;
const TEAMS: Team[] = [
  { id: "t-northwind", name: "northwind", role: "OWNER" },
  { id: "t-other", name: "Other", role: "OWNER" },
  { id: "t-acme", name: "Acme", role: "ADMIN" },
];

function mount(over: Partial<React.ComponentProps<typeof TeamMapStep>> = {}) {
  const fns = { onDone: vi.fn(), onStartOver: vi.fn() };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <TeamMapStep plan={plan()} sessionId="sess-1" teams={TEAMS} {...fns} {...over} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return fns;
}
const sel = (ref: string) => within(screen.getByTestId(`team-map-${ref}`)).getByRole("combobox") as HTMLSelectElement;
const next = () => screen.getByRole("button", { name: /Continue|Create the new teams and continue/ }) as HTMLButtonElement;

beforeEach(() => {
  vi.spyOn(api, "importTeamMap").mockImplementation(async (_s, teams) => ({ teamMap: Object.fromEntries(teams.map((t) => [t.sourceTeamRef, t.teamId])) }));
});

describe("TeamMapStep", () => {
  it("lists every Coolify team with what it holds and preselects the team of the same name, ignoring case", () => {
    mount();
    expect(screen.getByText("Northwind")).toBeTruthy();
    expect(screen.getByText("2 apps, databases and services · 1 projects · 1 servers")).toBeTruthy();
    expect(sel("1").value).toBe("t-northwind");
    expect(screen.getByText("Same name as your Tugra team.")).toBeTruthy();
    // the matched team is listed first
    expect(within(sel("1")).getAllByRole("option")[1].textContent).toBe("northwind");
  });

  it("a team with no match starts undecided, 'Create team' is offered but never preselected, and Continue says what is missing", () => {
    mount();
    expect(sel("3").value).toBe("");
    expect(within(sel("3")).getByRole("option", { name: "Create team Lab" })).toBeTruthy();
    expect(screen.getByText("Choose a team for every Coolify team, or leave it out.")).toBeTruthy();
    expect(next().disabled).toBe(true);
  });

  it("a team with that name that the person does not own is not offered, and the row explains why", () => {
    mount();
    expect(within(sel("2")).queryByRole("option", { name: "Acme" })).toBeNull();
    expect(screen.getByText(/you do not own it/)).toBeTruthy();
  });

  it("saves the mapping on the session: the recommended team, a chosen one, and null for a team left out", async () => {
    const { onDone } = mount();
    fireEvent.change(sel("2"), { target: { value: "t-other" } });
    fireEvent.change(sel("3"), { target: { value: "__skip" } });
    expect(screen.getByText("Nothing of this Coolify team is moved.")).toBeTruthy();
    fireEvent.click(next());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.importTeamMap).toHaveBeenCalledWith("sess-1", [
      { sourceTeamRef: "1", teamId: "t-northwind" },
      { sourceTeamRef: "2", teamId: "t-other" },
      { sourceTeamRef: "3", teamId: null },
    ]);
    expect(onDone).toHaveBeenCalledWith({ "1": "t-northwind", "2": "t-other", "3": null });
  });

  it("create-team path: nothing is written until Continue, then the team is made through the teams API and its new id is what is saved", async () => {
    const make = vi.spyOn(api, "createTeam").mockResolvedValue({ id: "t-new", name: "Lab", role: "OWNER" } as Team);
    const { onDone } = mount();
    fireEvent.change(sel("2"), { target: { value: "t-other" } });
    fireEvent.change(sel("3"), { target: { value: "__create" } });
    expect(make).not.toHaveBeenCalled();
    expect(screen.getByText(/Tugra creates this team when you continue/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create the new teams and continue" })).toBeTruthy();
    fireEvent.click(next());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(make).toHaveBeenCalledTimes(1);
    expect(make).toHaveBeenCalledWith("Lab");
    expect(api.importTeamMap).toHaveBeenCalledWith("sess-1", expect.arrayContaining([{ sourceTeamRef: "3", teamId: "t-new" }]));
  });

  it("a team that cannot be made stops here with the reason, and saves nothing", async () => {
    vi.spyOn(api, "createTeam").mockRejectedValue(new Error("nope"));
    const { onDone } = mount();
    fireEvent.change(sel("2"), { target: { value: "t-other" } });
    fireEvent.change(sel("3"), { target: { value: "__create" } });
    fireEvent.click(next());
    expect((await screen.findByRole("alert")).textContent).toBe("Could not create the team Lab: nope");
    expect(api.importTeamMap).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a retry after the save failed reuses the team already made instead of making a second one", async () => {
    const make = vi.spyOn(api, "createTeam").mockResolvedValue({ id: "t-new", name: "Lab", role: "OWNER" } as Team);
    (api.importTeamMap as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("down"));
    const { onDone } = mount();
    fireEvent.change(sel("2"), { target: { value: "t-other" } });
    fireEvent.change(sel("3"), { target: { value: "__create" } });
    fireEvent.click(next());
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save the team mapping: down");
    fireEvent.click(next());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("reopening it starts from the saved mapping", () => {
    mount({ plan: plan({ "1": "t-other", "2": null, "3": "t-northwind" }) });
    expect(sel("1").value).toBe("t-other");
    expect(sel("2").value).toBe("__skip");
    expect(sel("3").value).toBe("t-northwind");
  });

  it("every team left out cannot continue", () => {
    mount({ plan: plan({ "1": null, "2": null, "3": null }) });
    expect(screen.getByText("Every Coolify team is left out, so nothing would move.")).toBeTruthy();
    expect(next().disabled).toBe(true);
  });
});

describe("TeamFilterToggle with a team mapping", () => {
  const mounted = (teamMap: Record<string, string | null>, view: string | null, onView = vi.fn()) => {
    const scope = teamScope(plan(teamMap), view);
    render(
      <I18nProvider>
        <TeamFilterToggle scope={scope} showAll={false} hidden={scope?.hiddenHosts ?? 0} onChange={() => undefined} view={view} onView={onView} onChangeMap={() => undefined} />
      </I18nProvider>,
    );
    return onView;
  };

  it("says what it filters, with the counts: 'Northwind team: 2 of 4'", () => {
    mounted({ "1": "t-northwind", "2": "t-other", "3": null }, "1");
    expect(screen.getByText("Northwind team: 2 of 4")).toBeTruthy();
    expect(screen.getByText(/Apps, databases and services of the Coolify team/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change team mapping" })).toBeTruthy();
  });

  it("with several mapped teams in view it counts them together and switches between them", () => {
    const onView = mounted({ "1": "t-northwind", "2": "t-other", "3": null }, null);
    expect(screen.getByText("2 mapped teams: 3 of 4")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Coolify team"), { target: { value: "2" } });
    expect(onView).toHaveBeenCalledWith("2");
    fireEvent.change(screen.getByLabelText("Coolify team"), { target: { value: "__all" } });
    expect(onView).toHaveBeenCalledWith(null);
  });
});
