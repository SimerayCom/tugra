import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { ImportWizard } from "./import-wizard";
import { api } from "../lib/api";
import type { ImportPlan, ImportOperation } from "../lib/types";
import importMessages from "../i18n/locales/en/import.json";
import { readFileSync } from "node:fs";
import path from "node:path";

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
    // The post-import MigrateDataCard reads this on mount once the timeline settles — default to "no live token".
    vi.spyOn(api, "getMigrateCommand").mockResolvedValue({ opId: "op1", active: false, expiresAt: null, commandTemplate: "run on the source host" });
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

  it("post-import: mints the data-migration command, and previews + applies the env remap", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
    const mintSpy = vi.spyOn(api, "mintMigrationToken").mockResolvedValue({ opId: "op1", token: "T", command: "tugra-migrate --token T --hub https://hub", expiresAt: "2026-02-01T00:00:00.000Z" });
    vi.spyOn(api, "remapEnvPlan").mockResolvedValue({
      opId: "op1", planHash: "p".repeat(32), databases: [], skipped: [],
      apps: [{ itemRef: "app:srv:web", appId: "a1", name: "web-app", unchangedCount: 0,
        changes: [{ key: "DATABASE_URL", rule: "url", targetItemRef: "db:1", targetName: "pg", targetKind: "database", oldMasked: "postgres://old", newMasked: "postgres://new", confidence: "high" }],
        needsManual: [], dbNetwork: { willLink: true, databases: ["db:1"], serverDbCount: 1, hasUnauthEngine: false } }],
      note: "preview",
    });
    const applySpy = vi.spyOn(api, "remapEnvApply").mockResolvedValue({ opId: "op1", applied: true, planHash: "p".repeat(32), apps: [{ appId: "a1", name: "web-app", written: 1, keys: ["DATABASE_URL"], needsRedeploy: true, linked: true }], failed: [], linkFailed: [], note: "done" });
    wrap(<ImportWizard />);

    await screen.findByRole("option", { name: "Team One" });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("Import preview");
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("DONE");

    // Data migration: mint the one-liner (shown once).
    fireEvent.click(screen.getByRole("button", { name: "Generate migration command" }));
    await waitFor(() => expect(mintSpy).toHaveBeenCalledWith("op1"));
    await screen.findByText(/tugra-migrate --token T/);

    // Env remap: preview → apply with the planHash as the confirm token.
    fireEvent.click(screen.getByRole("button", { name: "Preview env changes" }));
    await screen.findByText("DATABASE_URL");
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await screen.findByText("Apply these env changes?"); // confirm dialog
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledWith("op1", "p".repeat(32)));
  });

  it("keeps the connect button disabled until url + token are filled", async () => {
    wrap(<ImportWizard />);
    await screen.findByRole("option", { name: "Team One" });
    const btn = screen.getByRole("button", { name: "Connect & preview" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ── G3-C: Dokploy source, coverage card, timeline "Not carried" ──────────────────────────────────────────
  const connectDokploy = async () => {
    await screen.findByRole("option", { name: "Team One" });
    fireEvent.click(screen.getByRole("radio", { name: "Dokploy" }));
    fireEvent.change(screen.getByLabelText("Dokploy URL"), { target: { value: "https://dokploy.example.com" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "dk" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
  };

  it("Dokploy: the same kind goes through connect, plan and apply; copy follows the source", async () => {
    const connectSpy = vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s2", expiresAt: "2026-01-01T00:00:00.000Z" });
    const planSpy = vi.spyOn(api, "importPlan").mockResolvedValue({ ...plan, sourceKind: "dokploy" });
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue({ ...settledOp, sourceKind: "dokploy" });
    wrap(<ImportWizard />);
    await connectDokploy();
    await screen.findByText("Import preview");
    expect(connectSpy).toHaveBeenCalledWith({ sourceKind: "dokploy", teamId: "t1", baseUrl: "https://dokploy.example.com", token: "dk" });
    expect(planSpy).toHaveBeenCalledWith({ sourceKind: "dokploy", sessionId: "s2" });
    await screen.findByRole("option", { name: "Server A" });
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("DONE");
    expect(applySpy).toHaveBeenCalledWith({ sourceKind: "dokploy", sessionId: "s2", targetServerId: "srv1", planHash: "a".repeat(32) });
    // post-import cards name the source
    expect(screen.getByText(/run it on your source \(Dokploy\) host/)).toBeTruthy();
    expect(screen.getByText(/instead of the old Dokploy one/)).toBeTruthy();
  });

  it("Coolify post-import copy is unchanged", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
    wrap(<ImportWizard />);
    await screen.findByRole("option", { name: "Team One" });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("DONE");
    expect(screen.getByText("Your databases were recreated empty. Generate a one-time command and run it on your source (Coolify) host to copy each database's data into its new Tugra database. The token works once and expires.")).toBeTruthy();
    expect(screen.getByText(/instead of the old Coolify one/)).toBeTruthy();
  });

  it("switching source clears the URL and token; the source picker is a radiogroup", async () => {
    wrap(<ImportWizard />);
    await screen.findByRole("option", { name: "Team One" });
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Coolify" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "coolify-token" } });
    fireEvent.click(screen.getByRole("radio", { name: "Dokploy" }));
    expect(screen.getByRole("radio", { name: "Dokploy" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Dokploy URL") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Connect with a Dokploy API key to preview all of its projects.")).toBeTruthy();
  });

  it("start over keeps the chosen source", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s2", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue({ ...plan, sourceKind: "dokploy" });
    wrap(<ImportWizard />);
    await connectDokploy();
    await screen.findByText("Import preview");
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    await screen.findByLabelText("Dokploy URL");
    expect(screen.getByRole("radio", { name: "Dokploy" }).getAttribute("aria-checked")).toBe("true");
  });

  it("renders a Dokploy project info risk on its item", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s2", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue({
      ...plan,
      sourceKind: "dokploy",
      items: [{ itemRef: "app:_:web", kind: "app", name: "web-app", proposed: {}, risks: [{ level: "info", code: "app.project", message: 'lands in project "Shop" / production' }], dependsOn: [] }],
    });
    wrap(<ImportWizard />);
    await connectDokploy();
    await screen.findByText('lands in project "Shop" / production');
  });

  it("shows the coverage card (collapsed, warn + info rows with text cues) only when the plan has coverage", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    const covered: ImportPlan = {
      ...plan,
      preflight: {
        databases: [], services: [], appsWithVolumeData: 0,
        coverage: { apps: [{ itemRef: "app:srv:web", name: "web-app", notCarried: [
          { field: "basicAuth", level: "warn", reason: "the source gated this app with HTTP basic auth" },
          { field: "limits", level: "info", reason: "resource limits are not carried from Coolify yet" },
        ] }] },
      },
    };
    const planSpy = vi.spyOn(api, "importPlan").mockResolvedValue(covered);
    const first = wrap(<ImportWizard />);
    await screen.findByRole("option", { name: "Team One" });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("What isn't carried over");
    expect(screen.getByText("Not carried (2)")).toBeTruthy();
    expect((screen.getByText("Not carried (2)").closest("details") as HTMLDetailsElement).open).toBe(false); // collapsed
    expect(screen.getByText("Review")).toBeTruthy(); // warn row: text cue, not colour alone
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.getByText(/the source gated this app with HTTP basic auth/)).toBeTruthy();
    expect(screen.getByText("Custom labels and Dockerfile text are read when you apply.")).toBeTruthy();
    first.unmount();

    planSpy.mockResolvedValue(plan);
    wrap(<ImportWizard />);
    await screen.findByRole("option", { name: "Team One" });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("Import preview");
    expect(screen.queryByText("What isn't carried over")).toBeNull();
  });

  it("timeline: a task with postCreate/ingress unmapped shows 'Not carried (n)' + Applied; a task without renders no disclosure", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue({
      ...settledOp,
      totals: { ...settledOp.totals, total: 2, done: 2 },
      tasks: [
        { ...settledOp.tasks[0], postCreate: { applied: ["build", "customLabels"], unmapped: [{ field: "customLabel:traefik.enable", reason: "in the reserved traefik.* namespace" }] }, ingress: { applied: [], unmapped: [{ field: "ports", reason: "r" }] } },
        { ...settledOp.tasks[0], itemRef: "app:srv:plain", name: "plain-app" },
      ],
    });
    wrap(<ImportWizard />);
    await screen.findByRole("option", { name: "Team One" });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("Not carried (2)");
    expect(screen.getByText(/customLabel:traefik\.enable/)).toBeTruthy();
    expect(screen.getByText("Applied: build, customLabels")).toBeTruthy();
    expect(screen.getAllByText(/^Not carried \(/)).toHaveLength(1); // only the task with something unmapped
  });
});

describe("import wizard i18n", () => {
  const lookup = (k: string): unknown => k.split(".").slice(1).reduce<unknown>((n, p) => (n && typeof n === "object" ? (n as Record<string, unknown>)[p] : undefined), importMessages);
  it("every literal import.* key used by the wizard resolves to a string in en/import.json", () => {
    const src = readFileSync(path.resolve(__dirname, "import-wizard.tsx"), "utf8");
    const used = new Set([...src.matchAll(/["'`](import\.[A-Za-z0-9_]+)["'`]/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(40);
    const missing = [...used].filter((k) => typeof lookup(k) !== "string");
    expect(missing).toEqual([]);
  });
  it("includes every key of the Dokploy source and the coverage report", () => {
    for (const k of ["sourcePicker", "sourceCoolifyOption", "sourceDokployOption", "sourceDokploy", "sourceDokployHint", "baseUrlDokploy", "baseUrlPlaceholderDokploy", "tokenDokploy", "tokenHintDokploy", "connectFailedDokploy", "coverageTitle", "coverageWarn", "coverageInfo", "coverageDeferred", "notCarriedCount", "appliedList", "sourceNameCoolify", "sourceNameDokploy"]) {
      expect(typeof lookup(`import.${k}`), k).toBe("string");
    }
  });
});
