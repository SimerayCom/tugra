import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { ConfirmProvider } from "../confirm";
import { api } from "../../lib/api";
import { RunDetail } from "./run-detail";
import { binding, mkRun, mkStep } from "./test-fixtures";
import { MIGRATION_RUN_STEP_KEYS } from "../../lib/migration-run";
import type { MigrationRunStepKey, MigrationRunStepStatus, MigrationRunStepView } from "../../lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);
let qc: QueryClient;
const wrap = (id = "run12345abcdef") =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <RunDetail id={id} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "getMigrationRunEvents").mockResolvedValue({ events: [], lastSeq: 0, hasMore: false });
  vi.spyOn(api, "getMigrationRunReport").mockRejectedValue(new Error("no report"));
  vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue({ imagePins: [], workerMarks: [], warningAcks: [] });
  vi.spyOn(api, "getMigrationRunSecretsConsent").mockResolvedValue({ applies: false, standing: false, classes: [], sessionId: null, serverId: null });
  vi.spyOn(api, "getRunInPlace").mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

const FLOW = MIGRATION_RUN_STEP_KEYS.filter((k) => k !== "DECOMMISSION");
const NOT_APPLICABLE: MigrationRunStepKey[] = ["DNS_PREPARE", "DATA_SEED", "FREEZE", "DATA_FINAL", "TLS_PREISSUE"];
const inPlaceSteps = (status: Partial<Record<MigrationRunStepKey, MigrationRunStepStatus>>, over: Partial<Record<MigrationRunStepKey, Partial<MigrationRunStepView>>> = {}) =>
  FLOW.map((k) => mkStep(k, NOT_APPLICABLE.includes(k) ? "SKIPPED" : (status[k] ?? "PENDING"), over[k] ?? {}));
const inPlaceRun = (over: Parameters<typeof mkRun>[0], steps: MigrationRunStepView[]) => mkRun({ inPlace: true, topology: "swap-proxy", mode: "takeover", ...over }, steps);

describe("the live step list at the top of a run page", () => {
  it("an in-place run shows the eight steps that apply, one state word each, and counts the ones that do not", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      inPlaceRun({ status: "RUNNING", currentStep: "DEPLOY_DARK", nextAction: { kind: "engine", stepKey: "DEPLOY_DARK", code: "run.started", since: "2026-11-16T10:00:00.000Z" } }, inPlaceSteps({ PREFLIGHT: "PASSED", IMPORT: "PASSED", REMAP_ENV: "PASSED", DEPLOY_DARK: "RUNNING" })),
    );
    wrap();
    const stepper = await screen.findByTestId("run-stepper");
    const rows = within(stepper).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-step"))).toEqual(["PREFLIGHT", "IMPORT", "REMAP_ENV", "DEPLOY_DARK", "VERIFY", "CUTOVER", "OBSERVE", "FINALIZE"]);
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["done", "done", "done", "working", "todo", "todo", "todo", "todo"]);
    expect(within(rows[3]).getByText("Working")).toBeTruthy();
    expect(within(rows[0]).getByText("Done")).toBeTruthy();
    expect(within(rows[4]).getByText("Not started")).toBeTruthy();
    expect(within(stepper).getByText("Step 4 of 8")).toBeTruthy();
    expect(screen.getByTestId("run-stepper-hidden").textContent).toBe("5 steps do not apply because nothing is copied.");
    // the steps that copy nothing are not drawn anywhere on the page, not even in the timeline
    expect(screen.queryByText("Freeze the source")).toBeNull();
    expect(screen.queryByText("Rehearse data copy")).toBeNull();
  });

  it("says plainly that closing the page stops nothing while the run is live", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(inPlaceRun({ status: "RUNNING", currentStep: "IMPORT" }, inPlaceSteps({ PREFLIGHT: "PASSED", IMPORT: "RUNNING" })));
    wrap();
    const note = await screen.findByTestId("run-stepper-note");
    expect(note.textContent).toBe("You can close this page. The hub keeps working and stops when it needs you.");
  });

  it("a step that waits for the owner reads 'Needs you' and leads to the card that says what", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      inPlaceRun(
        { status: "WAITING", currentStep: "VERIFY", nextAction: { kind: "approval", stepKey: "VERIFY", code: "verify.review", since: "2026-11-16T10:00:00.000Z", approval: binding({ confirm: "target-server" }) } },
        inPlaceSteps({ PREFLIGHT: "PASSED", IMPORT: "PASSED", REMAP_ENV: "PASSED", DEPLOY_DARK: "PASSED", VERIFY: "WAITING_APPROVAL" }),
      ),
    );
    wrap();
    const stepper = await screen.findByTestId("run-stepper");
    const verify = within(stepper).getAllByRole("listitem").find((r) => r.getAttribute("data-step") === "VERIFY")!;
    expect(verify.getAttribute("data-state")).toBe("needs-you");
    expect(within(verify).getByText("Needs you")).toBeTruthy();
    expect(within(verify).getByRole("link", { name: "See what is needed" }).getAttribute("href")).toBe("#mr-next-action");
    expect(document.getElementById("mr-next-action")?.textContent).toMatch(/What I am waiting for/);
  });

  it("a failed step names its failure in the list, in words", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      inPlaceRun({ status: "FAILED", currentStep: "IMPORT", nextAction: { kind: "failed", stepKey: "IMPORT", code: "step.failed", since: "2026-11-16T10:00:00.000Z" } }, inPlaceSteps({ PREFLIGHT: "PASSED", IMPORT: "FAILED" }, { IMPORT: { lastError: "import.apply-failed" } })),
    );
    wrap();
    const stepper = await screen.findByTestId("run-stepper");
    const row = within(stepper).getAllByRole("listitem").find((r) => r.getAttribute("data-step") === "IMPORT")!;
    expect(row.getAttribute("data-state")).toBe("failed");
    expect(within(row).getByText("Failed")).toBeTruthy();
    expect(screen.queryByTestId("run-stepper-note")).toBeNull(); // nothing is moving: no promise about the hub working on
  });

  it("a move to another server shows every step of the flow", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ status: "RUNNING", currentStep: "DATA_SEED" }, FLOW.map((k) => mkStep(k, k === "PREFLIGHT" || k === "IMPORT" ? "PASSED" : k === "DATA_SEED" ? "RUNNING" : "PENDING"))));
    wrap();
    const stepper = await screen.findByTestId("run-stepper");
    expect(within(stepper).getAllByRole("listitem")).toHaveLength(13);
    expect(screen.queryByTestId("run-stepper-hidden")).toBeNull();
  });

  it("a queued run starts with one click, no confirmation window, and says nothing touches production before the approval", async () => {
    const queued = inPlaceRun({ status: "QUEUED", currentStep: null, allowed: { ...mkRun().allowed, start: true, pause: false } }, inPlaceSteps({}));
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(queued);
    const start = vi.spyOn(api, "startMigrationRun").mockResolvedValue({ ...queued, status: "RUNNING" });
    wrap();
    expect((await screen.findByTestId("run-stepper-note")).textContent).toBe("Nothing touches production traffic until you approve the verification.");
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("run12345abcdef"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
