import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { useState } from "react";
import { I18nProvider } from "../../i18n/provider";
import { ConfirmProvider } from "../confirm";
import { ImportWizard } from "../import-wizard";
import { EnvBlockers } from "./env-blockers";
import { api } from "../../lib/api";
import { buildAcks, runnableAfterAcks, ackableItems } from "../../lib/import";
import type { ImportPlan } from "../../lib/types";

// the review's start action opens the launch page through the router
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

const unresolvedRisk = { level: "blocker" as const, code: "app.env.unresolved", message: "2 variable(s) cannot be carried and will be missing in the new app: SHARED_TOKEN (SHARED_UNEXPANDED), SERVICE_FQDN_WEB (MAGIC)" };
const invalidRisk = { level: "blocker" as const, code: "app.env.key.invalid", message: "1 variable name(s) are not valid environment keys and will be skipped: A=B" };
const readOnlyRisk = { level: "blocker" as const, code: "app.env.tokenReadOnly", message: "the API token cannot read variable values" };

const consentRisk = { level: "blocker" as const, code: "app.env.consentRequired", message: "the variable values are not read yet: allow reading secret values for this import" };

const basePlan = (items: ImportPlan["items"], env: NonNullable<NonNullable<ImportPlan["preflight"]>["coverage"]>["env"]): ImportPlan => ({
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: [],
  totals: { apps: items.length, databases: 0, volumes: 0, blockers: items.reduce((n, i) => n + i.risks.filter((r) => r.level === "blocker").length, 0) },
  items,
  preflight: { databases: [], services: [], appsWithVolumeData: 0, coverage: { apps: [], env } },
});

const app = (ref: string, name: string, risks: ImportPlan["items"][number]["risks"]): ImportPlan["items"][number] => ({ itemRef: `app:s:${ref}`, kind: "app", name, proposed: {}, risks, dependsOn: [] });

const plan = basePlan(
  [app("a1", "web-app", [unresolvedRisk, invalidRisk]), app("a2", "api-app", [unresolvedRisk]), app("a3", "clean-app", [])],
  {
    apps: [
      { itemRef: "app:s:a1", name: "web-app", unresolved: [{ key: "SHARED_TOKEN", reason: "SHARED_UNEXPANDED" }, { key: "SERVICE_FQDN_WEB", reason: "MAGIC" }], invalidKeys: ["A=B"], previewSkipped: 2, tokenReadOnly: false },
      { itemRef: "app:s:a2", name: "api-app", unresolved: [{ key: "NOPE", reason: "NO_VALUE" }], invalidKeys: [], previewSkipped: 0, tokenReadOnly: false },
    ],
  },
);

function Harness({ p = plan, onAcked }: { p?: ImportPlan; onAcked?: (s: ReadonlySet<string>) => void }) {
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  onAcked?.(acked);
  return <EnvBlockers plan={p} acked={acked} onChange={setAcked} />;
}
// Coolify opens on the agent path by default; these tests drive the token form, one click away.
const openToken = async () => {
  const btn = await screen.findByRole("button", { name: "Connect with an API token" });
  if (btn.getAttribute("aria-pressed") !== "true") fireEvent.click(btn);
  return screen.findByLabelText("Coolify URL");
};

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}><I18nProvider><ConfirmProvider>{ui}</ConfirmProvider></I18nProvider></QueryClientProvider>);

describe("EnvBlockers", () => {
  it("lists key NAMES with a translated reason label per app (never values), and ack-all ticks every app", () => {
    wrap(<Harness />);
    expect(screen.getByText("Variables that cannot be carried")).toBeTruthy();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(screen.getByText(/created WITHOUT these variables/)).toBeTruthy();
    for (const d of Array.from(document.querySelectorAll("details"))) d.setAttribute("open", "");
    expect(screen.getByText("SHARED_TOKEN")).toBeTruthy();
    expect(screen.getByText("(shared variable not expanded)")).toBeTruthy();
    expect(screen.getByText("(Coolify magic variable)")).toBeTruthy();
    expect(screen.getByText("(not a valid variable name)")).toBeTruthy();
    expect(screen.getByText("NOPE")).toBeTruthy();
    const all = screen.getByLabelText("Acknowledge all 2") as HTMLInputElement;
    fireEvent.click(all);
    expect((screen.getByLabelText("Create web-app without these variables") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Create api-app without these variables") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Create api-app without these variables"));
    expect((screen.getByLabelText("Acknowledge all 2") as HTMLInputElement).checked).toBe(false);
  });

  it("tokenReadOnly shows a non-ackable banner with NO checkbox", () => {
    const ro = basePlan([app("a9", "locked-app", [readOnlyRisk])], undefined);
    wrap(<Harness p={ro} />);
    expect(screen.getByText("The API token cannot read variable values")).toBeTruthy();
    expect(screen.getByText("locked-app")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(ackableItems(ro)).toEqual([]);
  });

  it("an agent session without the consent says to allow secret values, not to create a token, and offers no ack", () => {
    const need = basePlan([app("a8", "agent-app", [consentRisk])], undefined);
    wrap(<Harness p={need} />);
    expect(screen.getByText("Secret values are not allowed for this import yet")).toBeTruthy();
    expect(screen.getByText(/until you allow reading secret values for this import/)).toBeTruthy();
    expect(screen.queryByText("The API token cannot read variable values")).toBeNull();
    expect(screen.queryByText(/read:sensitive/)).toBeNull();
    expect(screen.getByText("agent-app")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(ackableItems(need)).toEqual([]);
    expect(runnableAfterAcks(need, new Set(["app:s:a8"]))).toBe(0);
  });

  it("renders nothing for a plan with no env blockers", () => {
    const { container } = wrap(<Harness p={basePlan([app("a", "x", [])], undefined)} />);
    expect(container.textContent).toBe("");
  });
});

describe("ack helpers", () => {
  it("buildAcks lists explicit per-item codes (never an ack-all); runnableAfterAcks counts acknowledged apps", () => {
    const acked = new Set(["app:s:a1"]);
    expect(buildAcks(plan, acked)).toEqual([{ code: "app.env.unresolved", itemRef: "app:s:a1" }, { code: "app.env.key.invalid", itemRef: "app:s:a1" }]);
    expect(runnableAfterAcks(plan, new Set())).toBe(1); // only clean-app
    expect(runnableAfterAcks(plan, acked)).toBe(2);
  });
  it("an acknowledged app that ALSO has a non-ackable blocker stays blocked", () => {
    const p = basePlan([app("a", "x", [unresolvedRisk, readOnlyRisk])], undefined);
    expect(runnableAfterAcks(p, new Set(["app:s:a"]))).toBe(0);
    expect(buildAcks(p, new Set(["app:s:a"]))).toEqual([{ code: "app.env.unresolved", itemRef: "app:s:a" }]);
  });
});

describe("ImportWizard — strict env gating", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/"); // a previous apply mirrored its op into ?op=
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team One" }] as never);
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv1", name: "Server A", teamId: "t1", status: "ONLINE", clusterId: null, tags: [] }] as never);
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
  });
  afterEach(() => vi.restoreAllMocks());

  it("Apply is disabled until every ackable blocker is acknowledged, then sends explicit acks", async () => {
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue({ id: "op1", sourceKind: "coolify", serverId: "srv1", planHash: "a".repeat(32), status: "RUNNING", cancelRequested: false, createdAt: "2026-10-18T00:00:00.000Z", totals: { total: 1, done: 0, failed: 0, skipped: 0, running: 1, pending: 0, cancelled: 0, rolledBack: 0 }, tasks: [] });
    wrap(<ImportWizard />);
    await openToken();
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect & preview" }) as HTMLButtonElement).disabled).toBe(false)); // the connection team has loaded
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("Variables that cannot be carried");
    await screen.findByRole("option", { name: "Server A" });
    const apply = screen.getByRole("button", { name: "Import to Tugra" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Acknowledge all 2"));
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(applySpy).toHaveBeenCalled());
    expect(applySpy.mock.calls[0][0]).toMatchObject({
      sourceKind: "coolify",
      planHash: "a".repeat(32),
      acks: [
        { code: "app.env.unresolved", itemRef: "app:s:a1" },
        { code: "app.env.key.invalid", itemRef: "app:s:a1" },
        { code: "app.env.unresolved", itemRef: "app:s:a2" },
      ],
    });
  });

  it("the timeline row names the variables an acknowledged app was created without (names only)", async () => {
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue({
      id: "op1", sourceKind: "coolify", serverId: "srv1", planHash: "a".repeat(32), status: "SUCCEEDED", cancelRequested: false, createdAt: "2026-10-18T00:00:00.000Z",
      totals: { total: 1, done: 1, failed: 0, skipped: 0, running: 0, pending: 0, cancelled: 0, rolledBack: 0 },
      tasks: [{ itemRef: "app:s:a1", kind: "app", name: "web-app", status: "DONE", resourceType: "application", resourceId: "x", message: null, unresolvedEnv: 2, unresolvedKeys: ["SHARED_TOKEN", "SERVICE_FQDN_WEB"], startedAt: null, finishedAt: null }],
    });
    vi.spyOn(api, "getMigrateCommand").mockResolvedValue({ opId: "op1", active: false, expiresAt: null, commandTemplate: "x" });
    wrap(<ImportWizard />);
    await openToken();
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect & preview" }) as HTMLButtonElement).disabled).toBe(false)); // the connection team has loaded
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
    fireEvent.click(screen.getByLabelText("Acknowledge all 2"));
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("Created without: SHARED_TOKEN, SERVICE_FQDN_WEB");
  });
});
