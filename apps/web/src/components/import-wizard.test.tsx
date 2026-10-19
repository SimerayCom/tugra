import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { ImportWizard } from "./import-wizard";
import { api } from "../lib/api";
import type { ImportPlan, ImportOperation } from "../lib/types";

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

const plan: ImportPlan = {
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: ["1 service needs a read:sensitive token"],
  totals: { apps: 1, databases: 0, volumes: 0, blockers: 1 },
  items: [
    { itemRef: "app:srv:web", kind: "app", name: "web-app", proposed: {}, risks: [], dependsOn: [] },
    { itemRef: "app:srv:api", kind: "app", name: "api-blocked", proposed: {}, risks: [{ level: "blocker", code: "x", message: "nothing to deploy" }], dependsOn: [] },
  ],
};

const settledOp: ImportOperation = {
  id: "op1",
  sourceKind: "coolify",
  serverId: "srv1",
  planHash: "a".repeat(32),
  status: "SUCCEEDED",
  cancelRequested: false,
  createdAt: "2026-10-18T00:00:00.000Z",
  totals: { total: 1, done: 1, failed: 0, skipped: 0, running: 0, pending: 0, cancelled: 0, rolledBack: 0 },
  tasks: [{ itemRef: "app:srv:web", kind: "app", name: "web-app", status: "DONE", resourceType: "application", resourceId: "a1", message: null, startedAt: null, finishedAt: null }],
  plan,
};

describe("ImportWizard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team One" }] as never);
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv1", name: "Server A", teamId: "t1", status: "ONLINE", clusterId: null, tags: [] }] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("connect → preview → apply onto a target → live timeline", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
    wrap(<ImportWizard />);

    await screen.findByRole("option", { name: "Team One" });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));

    await screen.findByText("Import preview");
    await screen.findByRole("option", { name: "Server A" }); // target picker populated
    expect(screen.getByText("nothing to deploy")).toBeTruthy(); // blocker risk surfaced

    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("DONE"); // the op query resolved + the task row rendered
    expect(applySpy).toHaveBeenCalledWith({ sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", planHash: "a".repeat(32) });
    expect(screen.getByText("web-app")).toBeTruthy();
    expect(screen.getByText(/Importing/)).toBeTruthy(); // timeline header
  });

  it("offers rollback on a settled op with a created app, and runs it after confirm", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
    const rb = vi.spyOn(api, "rollbackImport").mockResolvedValue({
      ...settledOp,
      tasks: [{ ...settledOp.tasks[0], status: "ROLLED_BACK" }],
    });
    wrap(<ImportWizard />);

    await screen.findByRole("option", { name: "Team One" });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("DONE");

    fireEvent.click(screen.getByRole("button", { name: "Roll back" })); // Timeline button
    await screen.findByText("Roll back this import?"); // confirm dialog
    fireEvent.click(screen.getByRole("button", { name: "Confirm" })); // dialog confirm
    await screen.findByText("ROLLED_BACK");
    expect(rb).toHaveBeenCalledWith("op1");
  });

  it("keeps the connect button disabled until url + token are filled", async () => {
    wrap(<ImportWizard />);
    await screen.findByRole("option", { name: "Team One" });
    const btn = screen.getByRole("button", { name: "Connect & preview" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
