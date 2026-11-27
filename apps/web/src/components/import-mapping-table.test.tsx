import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { ImportMappingTable } from "./import-mapping-table";
import { emptyDoc } from "../lib/import-mapping";
import type { ImportEffectiveItem, ImportPlan, ImportResolved } from "../lib/types";

afterEach(cleanup);

const WEB = "app:srv:web";
const WORKER = "app:srv:worker";
const plan = {
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: [],
  totals: { apps: 2, databases: 0, volumes: 0, blockers: 0 },
  items: [
    { itemRef: WEB, kind: "app", name: "web", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: WORKER, kind: "app", name: "worker", proposed: {}, risks: [], dependsOn: [] },
  ],
  mapping: { features: ["mapping-v1"], stored: null, storedVersion: null, scopeKey: "team-1" },
} as unknown as ImportPlan;
const eff = (ref: string, name: string, project: string | null): ImportEffectiveItem =>
  ({ itemRef: ref, kind: "app", sourceName: name, include: true, name, project, environment: null, origin: { name: "source", placement: "default" }, status: "pending", changed: [] }) as unknown as ImportEffectiveItem;
const resolved = {
  version: 1,
  effective: [eff(WEB, "web", "Shop"), eff(WORKER, "worker", "Blog")],
  projects: [],
  gitSources: [],
  conflicts: [],
  orphans: [],
  mappingHash: "h".padEnd(32, "0"),
  counts: { renamed: 0, moved: 0, excluded: 0, aliased: 0, newProjects: 0, newEnvironments: 0 },
} as unknown as ImportResolved;

function mount() {
  const onEdit = vi.fn();
  render(
    <I18nProvider>
      <ImportMappingTable plan={plan} doc={emptyDoc({ sourceKind: "coolify", scopeKey: "team-1" })} resolved={resolved} search="" filter="all" projects={[{ name: "Shop" }, { name: "Blog" }]} onEdit={onEdit} onResetItem={vi.fn()} onBulk={vi.fn()} onMoveGroup={vi.fn()} />
    </I18nProvider>,
  );
  return onEdit;
}
const dt = () => ({ setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "", dropEffect: "" });

describe("ImportMappingTable drag and drop", () => {
  it("dropping an item on another project group moves it there", () => {
    const onEdit = mount();
    const shop = screen.getByRole("region", { name: /Shop/ });
    const blog = screen.getByRole("region", { name: /Blog/ });
    const handle = within(shop).getByTestId("imp-drag-handle");
    const transfer = dt();
    fireEvent.dragStart(handle, { dataTransfer: transfer });
    fireEvent.dragOver(blog, { dataTransfer: transfer });
    fireEvent.drop(blog, { dataTransfer: transfer });
    expect(onEdit).toHaveBeenCalledWith(WEB, "project", "Blog", "web");
  });

  it("dropping an item back on its own group changes nothing", () => {
    const onEdit = mount();
    const shop = screen.getByRole("region", { name: /Shop/ });
    const handle = within(shop).getByTestId("imp-drag-handle");
    const transfer = dt();
    fireEvent.dragStart(handle, { dataTransfer: transfer });
    fireEvent.dragOver(shop, { dataTransfer: transfer });
    fireEvent.drop(shop, { dataTransfer: transfer });
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe("ImportMappingRow icons", () => {
  const itemPlan = (items: unknown[]) => ({ ...plan, items }) as unknown as ImportPlan;
  const row = (items: unknown[]) => {
    const r = { ...resolved, effective: [] } as unknown as ImportResolved;
    render(
      <I18nProvider>
        <ImportMappingTable plan={itemPlan(items)} doc={emptyDoc({ sourceKind: "coolify", scopeKey: "team-1" })} resolved={r} search="" filter="all" projects={[]} onEdit={vi.fn()} onResetItem={vi.fn()} onBulk={vi.fn()} onMoveGroup={vi.fn()} />
      </I18nProvider>,
    );
  };
  it("shows the brand of the image on an app row and the engine logo on a database row", () => {
    row([
      { itemRef: "app:s:n8n", kind: "app", name: "automation", proposed: { image: "n8nio/n8n:latest" }, risks: [], dependsOn: [] },
      { itemRef: "db:s:pg", kind: "database", name: "ledger", proposed: { engine: "POSTGRES", image: null }, risks: [], dependsOn: [] },
      { itemRef: "app:s:own", kind: "app", name: "billing", proposed: { image: "ghcr.io/acme/billing:1" }, risks: [], dependsOn: [] },
    ]);
    const group = (ref: string) => document.querySelector(`[data-itemref="${ref}"]`) as HTMLElement;
    expect(group("app:s:n8n").querySelector("img")?.getAttribute("src")).toBe("/icons/n8n.svg");
    expect(group("db:s:pg").querySelector("img")?.getAttribute("src")).toBe("/icons/postgresql.svg");
    expect(group("app:s:own").querySelector("img")).toBeNull();
  });
});
