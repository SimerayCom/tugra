import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import { ToastProvider } from "../toast";
import { GuidedLaunchForm } from "./guided-launch-form";
import { mkRun } from "./test-fixtures";
import { LAUNCH_HANDOFF_KEY, saveLaunchHandoff } from "../../lib/launch-handoff";
import type { ImportPlan } from "../../lib/types";
import type { ImportScope } from "../../lib/import-scope";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let qc: QueryClient;
const item = (itemRef: string, kind: "app" | "database" | "service", name = itemRef) => ({ itemRef, kind, name, proposed: {}, risks: [], dependsOn: [] });
const plan = {
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: [],
  totals: { apps: 3, databases: 1, volumes: 0, blockers: 0 },
  items: [item("app:s1:web", "app", "web"), item("app:s1:api", "app", "api"), item("database:s1:pg", "database", "pg"), item("app:s2:shop", "app", "shop"), item("app:s3:blog", "app", "blog")],
  preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "s1", name: "Alpha" }, { ref: "s2", name: "Beta" }, { ref: "s3", name: "Gamma" }] },
} as unknown as ImportPlan;
const servers = [
  { id: "srv1", name: "Server A", teamId: "t1" },
  { id: "srv2", name: "Server B", teamId: "t1" },
  { id: "srv3", name: "Server C", teamId: "t1" },
];
const scopeOf = (placed: Record<string, string>, kinds: Record<string, "in-place" | "other-server">): ImportScope => ({
  selection: { mode: "everything", hosts: new Set(), projects: new Set(), extra: new Set(), placement: placed },
  inScope: new Set(plan.items.map((i) => i.itemRef)),
  narrowed: false,
  defaultServerId: Object.values(placed)[0] ?? "",
  serverMap: undefined,
  placed,
  placementKind: kinds,
});
const allInPlace = scopeOf({ s1: "srv1", s2: "srv2", s3: "srv3" }, { s1: "in-place", s2: "in-place", s3: "in-place" });
const oneInPlace = scopeOf({ s1: "srv1" }, { s1: "in-place" });
const mixed = scopeOf({ s1: "srv1", s2: "srv2" }, { s1: "in-place", s2: "other-server" });
const runsOf = (kinds: Array<[string, "in-place" | "other-server", string]>) => kinds.map(([ref, kind, target], wave) => ({ sourceServerRef: ref, kind, targetServerId: target, topology: kind === "in-place" ? ("swap-proxy" as const) : ("two-box" as const), wave }));
const threeRuns = runsOf([["s1", "in-place", "srv1"], ["s2", "in-place", "srv2"], ["s3", "in-place", "srv3"]]);

const mount = (over: Partial<React.ComponentProps<typeof GuidedLaunchForm>> = {}) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <GuidedLaunchForm plan={plan} kind="coolify" sessionId="session-abc12345" servers={servers} extras={{}} scope={allInPlace} {...over} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
/** The runs of the label (what the progress and the start read); the busy check of the servers (active runs) sees none. */
const campaignRuns = (runs: unknown[]) => vi.spyOn(api, "listMigrationRuns").mockImplementation(((f: { campaign?: string }) => Promise.resolve(f.campaign ? runs : [])) as never);
const form = () => screen.findByTestId("guided-launch-form");

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  push.mockReset();
  window.sessionStorage.clear();
  vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ acmeEmail: "ops@example.com" } as never);
  vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
  vi.spyOn(api, "startMigrationRun").mockResolvedValue(mkRun({ id: "started" }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the launch page of a same-machine takeover shows only what applies", () => {
  beforeEach(() => {
    vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: "a".repeat(32), views: [], runs: threeRuns, failure: null });
  });

  it("asks for the servers, the certificate email and the observe window, and for nothing about copying data", async () => {
    mount();
    const f = await form();
    await waitFor(() => expect(within(f).getAllByTestId("in-place-card")).toHaveLength(3));
    // one card per server with what it holds
    const first = within(f).getAllByTestId("in-place-card")[0];
    expect(first.textContent).toContain("Alpha");
    expect(first.textContent).toContain("2 apps · 1 databases · 0 services");
    expect(within(f).getByLabelText(/certificate email|ACME/i)).toBeTruthy();
    expect(within(f).getByLabelText("Observe window (minutes)")).toBeTruthy();
    // nothing that only a data copy needs
    expect(within(f).queryByLabelText("Mode")).toBeNull();
    expect(within(f).queryByLabelText(/Who freezes the source|source controller/i)).toBeNull();
    expect(within(f).queryByText(/Advanced options/)).toBeNull();
    expect(within(f).queryByText(/bind-mounted|live shape|live probe/i)).toBeNull();
    expect(within(f).queryByText("Moves to another server")).toBeNull();
    // the rebuild choice is there, folded away by default
    expect(within(f).getAllByText(/Apps reuse Coolify's image \(default\)/)).toHaveLength(3);
  });

  it("fills the certificate email from the instance, wants one, and says why the button is off without it", async () => {
    vi.spyOn(api, "getInstanceSettings").mockRejectedValue(new Error("forbidden"));
    mount();
    const f = await form();
    const submit = await within(f).findByRole("button", { name: "Create 3 runs and start the first" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true));
    expect((await within(f).findByTestId("launch-why")).textContent).toContain("Enter the certificate email to start.");
    fireEvent.change(within(f).getByLabelText(/certificate email|ACME/i), { target: { value: "me@example.com" } });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("launch-why")).toBeNull();
  });

  it("is a real run by default, named, and reads 'Start the takeover' for one server", async () => {
    vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: "a".repeat(32), views: [], runs: runsOf([["s1", "in-place", "srv1"]]), failure: null });
    mount({ scope: oneInPlace });
    const f = await form();
    expect((within(f).getByRole("checkbox", { name: "Dry run first" }) as HTMLInputElement).checked).toBe(false);
    const name = within(f).getByLabelText("Name of this move") as HTMLInputElement;
    expect(name.value).toMatch(/^Moving off Coolify - /);
    await within(f).findByRole("button", { name: "Start the takeover" });
  });

  it("creates the campaign with the filled email, starts the first wave and opens the campaign page", async () => {
    const created = { id: "c1", label: "Moving off Coolify - test", sessionId: "session-abc12345", status: "draft" as const, plan: threeRuns, runIds: ["r1", "r2", "r3"], createdAt: "2026-11-28T07:48:00Z" };
    const createCampaign = vi.spyOn(api, "createCampaign").mockResolvedValue(created as never);
    const run = (id: string, target: string) => ({ id, targetServerId: target, inPlace: true, status: "QUEUED", createdAt: "2026-11-28T07:48:01Z", campaign: created.label });
    campaignRuns([run("r1", "srv1"), run("r2", "srv2"), run("r3", "srv3")]);
    mount();
    const f = await form();
    fireEvent.change(within(f).getByLabelText("Name of this move"), { target: { value: "Moving off Coolify - test" } });
    const submit = await within(f).findByRole("button", { name: "Create 3 runs and start the first" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(createCampaign).toHaveBeenCalledTimes(1));
    const body = createCampaign.mock.calls[0][0];
    expect(body).toMatchObject({ label: "Moving off Coolify - test", dryRun: false, confirm: 3, inputs: { acmeEmail: "ops@example.com" } });
    // only the first wave is started: the later ones wait for it
    await waitFor(() => expect(api.startMigrationRun).toHaveBeenCalledTimes(1));
    expect(api.startMigrationRun).toHaveBeenCalledWith("r1");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/import/runs/campaign?c=Moving%20off%20Coolify%20-%20test"));
  });

  it("shows each run being made instead of a spinning button, and cannot be submitted twice", async () => {
    let finish: (v: never) => void = () => undefined;
    const createCampaign = vi.spyOn(api, "createCampaign").mockImplementation(() => new Promise((r) => { finish = r as never; }));
    const made = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, targetServerId: `srv${i + 1}`, inPlace: true, status: "QUEUED", createdAt: new Date(Date.now() + 5000).toISOString(), campaign: "Mine" }));
    campaignRuns(made(2));
    mount();
    const f = await form();
    fireEvent.change(within(f).getByLabelText("Name of this move"), { target: { value: "Mine" } });
    const submit = await within(f).findByRole("button", { name: "Create 3 runs and start the first" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    const progress = await screen.findByTestId("launch-progress");
    await waitFor(() => expect(progress.textContent).toContain("Creating run 3 of 3: Gamma"));
    const states = within(progress).getAllByRole("listitem").map((li) => li.getAttribute("data-state"));
    expect(states).toEqual(["done", "done", "working"]);
    // the form is replaced by the progress; the button is busy, so a second click cannot make a second campaign
    expect(screen.queryByTestId("in-place-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Create 3 runs and start the first/ }));
    fireEvent.submit(f);
    expect(createCampaign).toHaveBeenCalledTimes(1);
    finish({ id: "c1", label: "Mine", sessionId: "s", status: "draft", plan: threeRuns, runIds: [], createdAt: "2026-11-28T07:48:00Z" } as never);
    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it("goes to the campaign even when the first run could not be started, and says so", async () => {
    vi.spyOn(api, "createCampaign").mockResolvedValue({ id: "c1", label: "Mine", sessionId: "s", status: "draft", plan: threeRuns, runIds: ["r1"], createdAt: "2026-11-28T07:48:00Z" } as never);
    campaignRuns([{ id: "r1", targetServerId: "srv1", inPlace: true, status: "QUEUED", createdAt: "2026-11-28T07:48:01Z", campaign: "Mine" }]);
    vi.spyOn(api, "startMigrationRun").mockRejectedValue(new Error("boom"));
    mount();
    const f = await form();
    const submit = await within(f).findByRole("button", { name: "Create 3 runs and start the first" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/import/runs/campaign?c=Mine"));
    expect(await screen.findByText(/could not be started/)).toBeTruthy();
  });
});

describe("the launch page says what starts now, what waits, and why the button is off", () => {
  beforeEach(() => {
    vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: "a".repeat(32), views: [], runs: threeRuns, failure: null });
  });
  // the certificate email arrives with the instance settings; the reason that follows it is the one under test
  const reasonOf = async (part: string) => {
    await waitFor(() => expect(screen.getByTestId("launch-why").textContent).toContain(part));
  };

  it("says before the click that only the first server starts and the rest start from the campaign page", async () => {
    mount();
    const f = await form();
    await within(f).findByRole("button", { name: "Create 3 runs and start the first" });
    expect(within(f).getByTestId("launch-waves-note").textContent).toContain("Only the first server starts now");
    expect(within(f).getByTestId("launch-waves-note").textContent).toContain("from the campaign page");
  });

  it("has no waiting servers to explain for a single run", async () => {
    vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: "a".repeat(32), views: [], runs: runsOf([["s1", "in-place", "srv1"]]), failure: null });
    mount({ scope: oneInPlace });
    const f = await form();
    await within(f).findByRole("button", { name: "Start the takeover" });
    expect(within(f).queryByTestId("launch-waves-note")).toBeNull();
  });

  it("names the reason while the placement is being checked", async () => {
    vi.spyOn(api, "planCampaign").mockImplementation(() => new Promise(() => undefined));
    mount();
    await reasonOf("Checking the placement");
  });

  it("names the reason when the placement could not be checked", async () => {
    vi.spyOn(api, "planCampaign").mockRejectedValue(new Error("boom"));
    mount();
    await reasonOf("could not be checked");
  });

  it("names the reason when a server of the move is busy with another run", async () => {
    vi.spyOn(api, "listMigrationRuns").mockImplementation(((f: { active?: boolean }) => Promise.resolve(f.active ? [{ id: "live1", targetServerId: "srv1", status: "RUNNING", dryRun: false }] : [])) as never);
    mount();
    await reasonOf("busy with another run");
  });
});

describe("a launch that stops partway does not leave the owner guessing", () => {
  beforeEach(() => {
    vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: "a".repeat(32), views: [], runs: threeRuns, failure: null });
  });
  const handoff = () => saveLaunchHandoff({ kind: "coolify", sessionId: "session-abc12345", planHash: "a".repeat(32), extras: {}, scope: allInPlace });
  const pressStart = async () => {
    const f = await form();
    fireEvent.change(within(f).getByLabelText("Name of this move"), { target: { value: "Mine" } });
    const submit = await within(f).findByRole("button", { name: "Create 3 runs and start the first" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    return f;
  };

  it("forgets the handoff once the runs exist, so Back from the run page cannot start a second campaign", async () => {
    handoff();
    expect(window.sessionStorage.getItem(LAUNCH_HANDOFF_KEY)).not.toBeNull();
    vi.spyOn(api, "createCampaign").mockResolvedValue({ id: "c1", label: "Mine", sessionId: "s", status: "draft", plan: threeRuns, runIds: ["r1"], createdAt: "2026-11-28T07:48:00Z" } as never);
    campaignRuns([{ id: "r1", targetServerId: "srv1", inPlace: true, status: "QUEUED", createdAt: "2026-11-28T07:48:01Z", campaign: "Mine" }]);
    mount();
    await pressStart();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/import/runs/campaign?c=Mine"));
    expect(window.sessionStorage.getItem(LAUNCH_HANDOFF_KEY)).toBeNull();
  });

  it("says how many runs were created when the create failed partway, links to the campaign and keeps the handoff", async () => {
    handoff();
    vi.spyOn(api, "createCampaign").mockRejectedValue(new Error("timeout"));
    const at = new Date(Date.now() + 5000).toISOString();
    campaignRuns([{ id: "r1", targetServerId: "srv1", inPlace: true, status: "QUEUED", createdAt: at, campaign: "Mine" }, { id: "r2", targetServerId: "srv2", inPlace: true, status: "QUEUED", createdAt: at, campaign: "Mine" }]);
    mount();
    await pressStart();
    const note = await screen.findByTestId("launch-partial");
    expect(note.textContent).toContain("2 of 3 runs were created");
    expect(within(note).getByRole("link", { name: "Open the campaign" }).getAttribute("href")).toBe("/import/runs/campaign?c=Mine");
    expect(push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(LAUNCH_HANDOFF_KEY)).not.toBeNull();
    // nothing was started, and the form is back
    expect(api.startMigrationRun).not.toHaveBeenCalled();
    expect(screen.queryByTestId("launch-progress")).toBeNull();
  });

  it("says nothing extra when no run was made before the failure", async () => {
    vi.spyOn(api, "createCampaign").mockRejectedValue(new Error("refused"));
    campaignRuns([]);
    mount();
    await pressStart();
    await waitFor(() => expect(screen.queryByTestId("launch-progress")).toBeNull());
    expect(screen.queryByTestId("launch-partial")).toBeNull();
  });
});

describe("a move to another server keeps its own section", () => {
  it("shows Mode, who freezes the source and the advanced options only when some server moves, and starts as a dry run", async () => {
    vi.spyOn(api, "planCampaign").mockResolvedValue({ planHash: "a".repeat(32), views: [], runs: runsOf([["s2", "other-server", "srv2"], ["s1", "in-place", "srv1"]]), failure: null });
    mount({ scope: mixed });
    const f = await form();
    await within(f).findByText("Moves to another server");
    expect(within(f).getByLabelText("Mode")).toBeTruthy();
    expect(within(f).getByText(/Advanced options/)).toBeTruthy();
    expect((within(f).getByRole("checkbox", { name: "Dry run first" }) as HTMLInputElement).checked).toBe(true);
    // the campaign name is asked once, at the top, not again under Advanced
    expect(within(f).getAllByLabelText(/Name of this move|^Campaign$/)).toHaveLength(1);
  });
});
