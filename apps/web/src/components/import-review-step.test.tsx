import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { ImportReviewStep } from "./import-review-step";
import { api } from "../lib/api";
import { subscribeToast } from "../lib/toast-bus";
import type { ImportApplyExtras, ImportMappingDoc, ImportPlan, ImportResolved, ImportEffectiveItem, ImportConflict } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const APP = "app:srv:web";
const WORKER = "app:srv:worker";
const DB = "database:srv:orders";
const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: [],
  totals: { apps: 2, databases: 1, volumes: 0, blockers: 0 },
  items: [
    { itemRef: APP, kind: "app", name: "web", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: WORKER, kind: "app", name: "worker", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: DB, kind: "database", name: "orders", proposed: {}, risks: [], dependsOn: [] },
  ],
  mapping: { features: ["mapping-v1"], stored: null, storedVersion: null, scopeKey: "team-3" },
  ...over,
});

const eff = (ref: string, kind: "app" | "database", name: string, over: Partial<ImportEffectiveItem> = {}): ImportEffectiveItem => ({
  itemRef: ref, kind, sourceName: name, include: true, name, project: null, environment: null, origin: { name: "source", placement: "default" }, status: "pending", changed: [], ...over,
});

/** A resolver stub: echoes the doc's renames/excludes so the UI reflects what the (real) hub would return. */
const resolveFor = (extra: { conflicts?: ImportConflict[]; orphans?: string[] } = {}) => (input: { mapping: ImportMappingDoc }): Promise<ImportResolved> => {
  const it = input.mapping.items;
  const mk = (ref: string, kind: "app" | "database", src: string) => eff(ref, kind, it[ref]?.name ?? src, { include: it[ref]?.include !== false, status: it[ref]?.include === false ? "excluded" : "pending", changed: it[ref]?.name ? ["name"] : [] });
  const effective = [mk(APP, "app", "web"), mk(WORKER, "app", "worker"), mk(DB, "database", "orders")];
  return Promise.resolve({
    version: 1,
    effective,
    projects: [{ name: "Shop", environments: ["production"], willCreate: false, envsToCreate: [], itemCount: 1 }],
    gitSources: [],
    conflicts: extra.conflicts ?? [],
    orphans: extra.orphans ?? [],
    mappingHash: `h${JSON.stringify(input.mapping).length}`.padEnd(32, "0"),
    counts: { renamed: Object.values(it).filter((x) => x.name).length, moved: 0, excluded: effective.filter((e) => e.status === "excluded").length, aliased: 0, newProjects: 0, newEnvironments: 0 },
  });
};

const servers = [
  { id: "srv1", name: "Server A", teamId: "t1" },
  { id: "srv2", name: "Server B", teamId: "t2" },
];
const teams = [
  { id: "t1", name: "Team One", role: "OWNER" },
  { id: "t2", name: "Team Two", role: "OWNER" },
] as never;

const mount = (p: ImportPlan = plan(), over: { onApplied?: (id: string) => void; applyExtras?: ImportApplyExtras } = {}) =>
  wrap(<ImportReviewStep plan={p} kind="coolify" sessionId="s1" servers={servers} teams={teams} applyExtras={over.applyExtras} onApplied={over.onApplied ?? (() => undefined)} onBack={() => undefined} />);

describe("ImportReviewStep", () => {
  let resolveSpy: ReturnType<typeof vi.spyOn>;
  let toasts: string[];
  let unsub: () => void;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    resolveSpy = vi.spyOn(api, "importResolve").mockImplementation(resolveFor() as never);
    vi.spyOn(api, "importMappingGet").mockResolvedValue({ doc: null, version: null, label: null, lastAppliedAt: null });
    toasts = [];
    unsub = subscribeToast((m) => toasts.push(m.message));
  });
  afterEach(() => {
    unsub();
    vi.restoreAllMocks();
  });

  it("resolves on entry, groups servers by team, derives the target team read-only, and enables Apply with counts", async () => {
    mount();
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(1));
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", sourceKind: "coolify", planHash: "a".repeat(32), targetServerId: "srv1", mapping: expect.objectContaining({ version: 1, scope: { sourceKind: "coolify", scopeKey: "team-3" } }) }));
    expect(screen.getByRole("group", { name: "Team One" })).toBeTruthy(); // optgroup per team
    expect(screen.getByText("Target team: Team One (derived from the server)")).toBeTruthy();
    const apply = await screen.findByRole("button", { name: "Apply 2 apps, 1 databases; 0 excluded" });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Target server"), { target: { value: "srv2" } });
    expect(screen.getByText("Target team: Team Two (derived from the server)")).toBeTruthy();
  });

  it("an edit is debounced (~800 ms) and Apply is disabled until the resolve is fresh; then it carries mapping + mappingHash", async () => {
    const onApplied = vi.fn();
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1", mappingApplied: true });
    mount(plan(), { onApplied });
    const apply0 = await screen.findByRole("button", { name: /^Apply 2 apps/ });
    await waitFor(() => expect((apply0 as HTMLButtonElement).disabled).toBe(false));

    const nameInput = screen.getAllByLabelText("Name in Tugra")[0] as HTMLInputElement; // web
    fireEvent.change(nameInput, { target: { value: "Storefront" } });
    fireEvent.blur(nameInput);
    // not resolved yet: Apply is disabled (stale / in flight) and the live region says so
    await waitFor(() => expect((screen.getByRole("button", { name: /^Apply 2 apps/ }) as HTMLButtonElement).disabled).toBe(true));
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(resolveSpy.mock.calls[1][0]).toMatchObject({ mapping: { items: { [APP]: { name: "Storefront" } } } });
    await waitFor(() => expect((screen.getByRole("button", { name: /^Apply 2 apps/ }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: /^Apply 2 apps/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" })); // the confirm dialog summarises the counts first
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    const sent = applySpy.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toMatchObject({ sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", planHash: "a".repeat(32), mapping: { items: { [APP]: { name: "Storefront" } } } });
    expect(sent.mappingHash).toMatch(/^h\d+0+$/);
    expect(sent.reconcile).toBeUndefined();
    expect(sent.ignoreStoredMapping).toBeUndefined();
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith("op1"));
  }, 15000);

  it("the plan step's acks, service choices and data modes ride along on the resolve and on the mapped apply", async () => {
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1", mappingApplied: true });
    const applyExtras: ImportApplyExtras = { acks: [{ code: "app.env.unresolved", itemRef: APP }], serviceChoices: { "service:srv:x": { skip: true } }, dbDataModes: { [DB]: "volume" } };
    mount(plan(), { applyExtras });
    const apply = await screen.findByRole("button", { name: /^Apply 2 apps/ });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    expect(resolveSpy.mock.calls[0][0]).toMatchObject({ acks: applyExtras.acks, dbDataModes: applyExtras.dbDataModes });
    expect(resolveSpy.mock.calls[0][0]).not.toHaveProperty("serviceChoices");
    fireEvent.click(apply);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0][0]).toMatchObject({ ...applyExtras, mapping: expect.anything(), mappingHash: expect.any(String) });
  });

  it("the extras also ride along on the 'ignore the saved mapping' apply", async () => {
    const stored: ImportMappingDoc = { version: 1, items: { [APP]: { name: "Storefront" } }, projects: {}, gitSources: {}, acks: [] };
    vi.spyOn(api, "importMappingGet").mockResolvedValue({ doc: stored, version: 3, label: null, lastAppliedAt: "2026-11-01T10:00:00.000Z" });
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op2" });
    const applyExtras: ImportApplyExtras = { acks: [{ code: "app.env.unresolved", itemRef: APP }], dbDataModes: { [DB]: "volume" } };
    mount(plan({ mapping: { features: ["mapping-v1"], stored, storedVersion: 3, scopeKey: "team-3" } }), { applyExtras });
    await screen.findByText(/Saved mapping loaded/);
    fireEvent.click(screen.getByRole("checkbox", { name: "Ignore the saved mapping and import with source names" }));
    const apply = screen.getByRole("button", { name: "Apply" });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0][0]).toEqual({ sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", planHash: "a".repeat(32), ...applyExtras, ignoreStoredMapping: true });
  });

  it("an apply the hub did not echo as applied (an old hub) is reported, and the op is still followed", async () => {
    const onApplied = vi.fn();
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    mount(plan(), { onApplied });
    const apply = await screen.findByRole("button", { name: /^Apply 2 apps/ });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith("op1"));
    expect(toasts.some((m) => m.includes("did not apply the mapping"))).toBe(true);
  });

  it("errors and un-acknowledged conflicts block Apply; ticking the ack writes doc.acks and re-resolves", async () => {
    const dup: ImportConflict = { code: "name.duplicate", level: "warn", itemRef: APP, field: "name", params: { name: "web" }, requiresAck: true, ackKey: `name.duplicate:${APP}`, acked: false };
    resolveSpy.mockImplementation(((input: { mapping: ImportMappingDoc }) => resolveFor({ conflicts: [{ ...dup, acked: input.mapping.acks.includes(dup.ackKey!) }] })(input)) as never);
    mount();
    const box = await screen.findByRole("checkbox", { name: "I accept the duplicate name" });
    expect((await screen.findByRole("button", { name: /^Apply 2 apps/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Fix the errors and acknowledge the conflicts to apply.").length).toBeGreaterThan(0);
    fireEvent.click(box);
    await waitFor(() => expect(resolveSpy.mock.calls.at(-1)![0]).toMatchObject({ mapping: { acks: [`name.duplicate:${APP}`] } }), { timeout: 3000 });
    await waitFor(() => expect((screen.getByRole("button", { name: /^Apply 2 apps/ }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
  }, 15000);

  it("an ERROR conflict blocks Apply with an icon plus text (not colour alone)", async () => {
    resolveSpy.mockImplementation(resolveFor({ conflicts: [{ code: "alias.reserved", level: "error", itemRef: APP, field: "containerAlias", params: {} }] }) as never);
    mount();
    await waitFor(() => expect(screen.getAllByText(/Aliases starting with tugra/).length).toBeGreaterThan(0));
    expect((screen.getByRole("button", { name: /^Apply 2 apps/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Error", { exact: false }).length).toBeGreaterThan(0);
  });

  it("orphans: the banner offers Remove all, which drops the keys from the document and re-resolves", async () => {
    const stored: ImportMappingDoc = { version: 1, items: { "app:srv:gone": { name: "x" }, [APP]: { name: "Storefront" } }, projects: {}, gitSources: {}, acks: [] };
    resolveSpy.mockImplementation(((input: { mapping: ImportMappingDoc }) => resolveFor({ orphans: Object.keys(input.mapping.items).filter((k) => k === "app:srv:gone") })(input)) as never);
    mount(plan({ mapping: { features: ["mapping-v1"], stored, storedVersion: 2, scopeKey: "team-3" } }));
    expect(await screen.findByText("1 mapped items no longer exist in the source.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Apply 2 apps/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
    await waitFor(() => expect(resolveSpy.mock.calls.at(-1)![0].mapping.items).toEqual({ [APP]: { name: "Storefront" } }), { timeout: 3000 });
  }, 15000);

  it("a saved profile is preloaded as the editable default with a banner; 'Ignore saved mapping' applies without any mapping", async () => {
    const stored: ImportMappingDoc = { version: 1, items: { [APP]: { name: "Storefront" } }, projects: {}, gitSources: {}, acks: [] };
    vi.spyOn(api, "importMappingGet").mockResolvedValue({ doc: stored, version: 3, label: null, lastAppliedAt: "2026-11-01T10:00:00.000Z" });
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op2" });
    mount(plan({ mapping: { features: ["mapping-v1"], stored, storedVersion: 3, scopeKey: "team-3" } }));
    await waitFor(() => expect(resolveSpy.mock.calls[0][0].mapping.items).toEqual({ [APP]: { name: "Storefront" } }));
    expect((await screen.findByText(/Saved mapping loaded \(v3, last applied/)).textContent).toMatch(/v3/);
    expect((screen.getAllByLabelText("Name in Tugra")[0] as HTMLInputElement).value).toBe("Storefront");
    fireEvent.click(screen.getByRole("checkbox", { name: "Ignore the saved mapping and import with source names" }));
    const apply = screen.getByRole("button", { name: "Apply" });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0][0]).toEqual({ sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", planHash: "a".repeat(32), ignoreStoredMapping: true });
  });

  it("a server refusal with a mapping code shows a fixed translation, not the raw message", async () => {
    const { ApiError } = await import("../lib/api");
    vi.spyOn(api, "importApply").mockRejectedValue(new ApiError(409, "raw english", "import.mapping_required"));
    mount();
    const apply = await screen.findByRole("button", { name: /^Apply 2 apps/ });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(toasts.some((m) => m.startsWith("A saved mapping exists for this source"))).toBe(true));
  });

  it("advisory validation: aria-invalid + aria-describedby with an icon and text; Esc reverts the draft; Enter commits", async () => {
    mount();
    await screen.findByRole("button", { name: /^Apply 2 apps/ });
    const input = screen.getAllByLabelText("Name in Tugra")[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a".repeat(101) } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const errId = input.getAttribute("aria-describedby")!;
    expect(document.getElementById(errId)!.textContent).toMatch(/longer than 100 characters/);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("web");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(input, { target: { value: "front" } });
    fireEvent.keyDown(input, { key: "Enter" }); // Enter blurs -> commit
    fireEvent.blur(input);
    await waitFor(() => expect(resolveSpy.mock.calls.at(-1)![0].mapping.items[APP]).toEqual({ name: "front" }), { timeout: 3000 });
  }, 15000);

  it("touch targets are 44px and there is a polite live region with the counts", async () => {
    mount();
    await screen.findByRole("button", { name: /^Apply 2 apps/ });
    expect((screen.getAllByLabelText("Name in Tugra")[0] as HTMLInputElement).style.minHeight).toBe("44px");
    expect((screen.getByLabelText("Include web") as HTMLInputElement).style.width).toBe("20px");
    const live = document.querySelector('[aria-live="polite"]')!;
    await waitFor(() => expect(live.textContent).toMatch(/2 apps, 1 databases, 0 renamed/));
    // each row is a labelled group that wraps into a card (auto-fit grid) on narrow screens
    expect(screen.getByRole("group", { name: "Mapping for web" })).toBeTruthy();
  });

  it("filters and search narrow the rows; 'Changed' shows only edited ones", async () => {
    mount();
    await screen.findByRole("button", { name: /^Apply 2 apps/ });
    expect(screen.getAllByLabelText("Name in Tugra")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Search by name"), { target: { value: "orders" } });
    expect(screen.getAllByLabelText("Name in Tugra")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search by name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "Changed" }));
    expect(screen.getByText("Nothing matches the filter.")).toBeTruthy();
  });

  it("bulk edit expands into explicit rows; Undo reverts the whole bulk action", async () => {
    mount();
    await screen.findByRole("button", { name: /^Apply 2 apps/ });
    fireEvent.click(screen.getAllByRole("button", { name: "Bulk edit" })[0]); // the group's bulk button
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Text"), { target: { value: "prod-" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply to all" }));
    await waitFor(() => expect((screen.getAllByLabelText("Name in Tugra")[0] as HTMLInputElement).value).toBe("prod-web"));
    expect((screen.getAllByLabelText("Name in Tugra")[2] as HTMLInputElement).value).toBe("prod-orders");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect((screen.getAllByLabelText("Name in Tugra")[0] as HTMLInputElement).value).toBe("web"));
  });

  it("upload: a file for another source team is blocked; a matching one shows a diff and loads on confirm", async () => {
    mount();
    await screen.findByRole("button", { name: /^Apply 2 apps/ });
    const file = (doc: unknown) => new File([JSON.stringify(doc)], "m.json", { type: "application/json" });
    const input = screen.getByLabelText("Upload mapping", { selector: "input" }) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file({ version: 1, scope: { sourceKind: "coolify", scopeKey: "team-5" }, items: {} })] } });
    expect(await screen.findByText("This file was made for another source team or token and cannot be used here.")).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(["not json"], "m.json")] } });
    expect(await screen.findByText("That file is not valid JSON.")).toBeTruthy();
    fireEvent.change(input, { target: { files: [file({ version: 1, scope: { sourceKind: "coolify", scopeKey: "team-3" }, items: { [WORKER]: { name: "jobs" } } })] } });
    expect(await screen.findByText("Uploading this file changes 1 fields. Review the changes, then load it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load file" }));
    await waitFor(() => expect((screen.getAllByLabelText("Name in Tugra")[1] as HTMLInputElement).value).toBe("jobs"));
  });

  it("reconcile is off by default and is sent only when ticked (it is part of the reviewed hash)", async () => {
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op3", mappingApplied: true });
    mount();
    await screen.findByRole("button", { name: /^Apply 2 apps/ });
    const box = screen.getByRole("checkbox", { name: /Reconcile already-imported items/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(resolveSpy.mock.calls.at(-1)![0].reconcile).toBe(true), { timeout: 3000 });
    const apply = screen.getByRole("button", { name: /^Apply 2 apps/ });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(apply);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(applySpy).toHaveBeenCalled());
    expect(applySpy.mock.calls[0][0]).toMatchObject({ reconcile: true });
  }, 15000);
});
