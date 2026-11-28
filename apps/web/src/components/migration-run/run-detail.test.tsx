import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { ConfirmProvider } from "../confirm";
import { api } from "../../lib/api";
import { RunDetail } from "./run-detail";
import { HASH, binding, mkRun, mkStep } from "./test-fixtures";
import { MIGRATION_RUN_STEP_KEYS } from "../../lib/migration-run";
import type { MigrationRunSecretsConsent, MigrationRunStepKey, MigrationRunStepStatus, MigrationRunStepView, MigrationRunView } from "../../lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../import-volume-transfers", () => ({ ImportVolumeTransfers: ({ opId }: { opId: string }) => <div>volumes-panel:{opId}</div> }));
vi.mock("../cutover-panel", () => ({ CutoverPanel: ({ opId }: { opId: string }) => <div>cutover-panel:{opId}</div> }));

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
  push.mockReset();
  vi.spyOn(api, "getMigrationRunEvents").mockResolvedValue({ events: [], lastSeq: 0, hasMore: false });
  vi.spyOn(api, "getMigrationRunReport").mockRejectedValue(new Error("no report"));
  vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue({ imagePins: [], workerMarks: [], warningAcks: [] });
  vi.spyOn(api, "getMigrationRunSecretsConsent").mockResolvedValue({ applies: false, standing: false, classes: [], sessionId: null, serverId: null });
});
afterEach(() => vi.restoreAllMocks());

const FLOW = MIGRATION_RUN_STEP_KEYS.filter((k) => k !== "DECOMMISSION");
const stepsWith = (over: Partial<Record<MigrationRunStepKey, MigrationRunStepView>>, base: MigrationRunStepStatus = "PENDING") => FLOW.map((k) => over[k] ?? mkStep(k, base));

describe("RunDetail", () => {
  it("renders the status, every step in order, and the point-of-no-return divider", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ status: "RUNNING", currentStep: "DATA_SEED" }, stepsWith({ PREFLIGHT: mkStep("PREFLIGHT", "PASSED"), IMPORT: mkStep("IMPORT", "PASSED"), DATA_SEED: mkStep("DATA_SEED", "RUNNING") })));
    wrap();
    await screen.findByText("coolify.example.org → tugra-1");
    const list = screen.getByRole("list", { name: "Steps" });
    const items = within(list).getAllByRole("listitem");
    // 13 steps + the PONR divider before CUTOVER
    expect(items).toHaveLength(14);
    expect(screen.getByText("Point of no return ahead")).toBeTruthy();
    expect(within(list).getByText("Preflight")).toBeTruthy();
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Before the point of no return you can abort/)).toBeTruthy();
  });

  describe("the consent for secret values, on the page of a run that needs it", () => {
    const missing: MigrationRunSecretsConsent = { applies: true, standing: false, classes: [], sessionId: "s1", serverId: "host1" };
    const waiting = (over: Partial<MigrationRunView> = {}) =>
      mkRun({ status: "WAITING", currentStep: "IMPORT", nextAction: { kind: "gate", stepKey: "IMPORT", code: "import.consent-required", since: "2026-11-16T10:00:00.000Z" }, ...over }, stepsWith({ PREFLIGHT: mkStep("PREFLIGHT", "PASSED") }));

    it("a run that waits for it shows the card to allow it (the owner's name typed), in plain words, and continues by itself after", async () => {
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(waiting());
      vi.spyOn(api, "getMigrationRunSecretsConsent").mockResolvedValue(missing);
      vi.spyOn(api, "listServers").mockResolvedValue([{ id: "host1", name: "Coolify host", teamId: "t9", status: "ONLINE" }] as never);
      const grant = vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue({ id: "g1", kind: "secrets", serverId: "host1", classes: ["env"], status: "active", grantedById: "u", expiresAt: "2099-01-01T00:00:00Z", revokedAt: null, createdAt: "2026-11-26T10:00:00Z" } as never);
      wrap();
      const panel = await screen.findByTestId("run-consent");
      expect(panel.textContent).toMatch(/continues by itself once you do/);
      expect(screen.getAllByText(/waiting for you to allow reading secret values/).length).toBeGreaterThan(0); // the step's own code has its sentence
      fireEvent.change(within(panel).getByLabelText("Type the Coolify server name to allow it"), { target: { value: "Coolify host" } });
      fireEvent.click(within(panel).getByRole("button", { name: "Allow" }));
      await waitFor(() => expect(grant).toHaveBeenCalledWith(expect.objectContaining({ serverId: "host1", importSessionId: "s1" })));
      await screen.findByText("Secret values are allowed for this import");
    });

    const asks = (answer = missing) => {
      vi.spyOn(api, "listServers").mockResolvedValue([{ id: "host1", name: "Coolify host", teamId: "t9", status: "ONLINE" }] as never);
      return vi.spyOn(api, "getMigrationRunSecretsConsent").mockResolvedValue(answer);
    };

    it("a queued real run shows it before Start", async () => {
      asks();
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ status: "QUEUED", currentStep: null }, stepsWith({})));
      wrap();
      await screen.findByTestId("run-consent");
    });

    it("a dry run and a settled run are never asked (they import nothing)", async () => {
      const ask = asks();
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ currentStep: null, dryRun: true, status: "RUNNING" }, stepsWith({})));
      wrap();
      await screen.findByText("coolify.example.org → tugra-1");
      cleanup();
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ currentStep: null, status: "COMPLETED" }, stepsWith({})));
      wrap();
      await screen.findByText("coolify.example.org → tugra-1");
      expect(ask).not.toHaveBeenCalled();
      expect(screen.queryByTestId("run-consent")).toBeNull();
    });

    it("a consent that stands shows nothing", async () => {
      const ask = asks({ ...missing, standing: true, classes: ["env"] });
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ status: "QUEUED", currentStep: null }, stepsWith({})));
      wrap();
      await screen.findByText("coolify.example.org → tugra-1");
      await waitFor(() => expect(ask).toHaveBeenCalled());
      expect(screen.queryByTestId("run-consent")).toBeNull();
    });
  });

  it("shows exactly one 'what I am waiting for' card with an operator command that is shown once", async () => {
    const step = mkStep("DATA_FINAL", "WAITING_OPERATOR", { kind: "operator", allowed: { approve: false, retry: false, skip: false, evidence: false, attach: false, command: true } });
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      mkRun({ currentStep: "DATA_FINAL", nextAction: { kind: "operator", stepKey: "DATA_FINAL", code: "data-final.run-migrator", since: "2026-11-16T10:00:00.000Z", offersCommand: true } }, stepsWith({ DATA_FINAL: step })),
    );
    const mint = vi.spyOn(api, "migrationRunCommand").mockResolvedValue({ stepKey: "DATA_FINAL", opId: "op1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), command: "curl -fsSL https://hub/x | sh", shownOnce: true });
    wrap();
    await screen.findByText("What I am waiting for");
    expect(screen.getByText("You · Final data copy")).toBeTruthy();
    expect(screen.getByText("data final: run migrator")).toBeTruthy(); // unknown code is humanized, not hidden
    fireEvent.click(screen.getByRole("button", { name: "Get the source-host command" }));
    await screen.findByText("curl -fsSL https://hub/x | sh");
    expect(mint).toHaveBeenCalledWith("run12345abcdef", "DATA_FINAL", { reissue: false });
    expect(screen.getByText(/Shown once/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("curl -fsSL https://hub/x | sh")).toBeNull();
  });

  it("renders the typed approval from the next action, bound to its hash", async () => {
    const b = binding({ confirm: "target-server", ponr: true, requiresDataRisk: true, ttlSec: 1800 });
    const step = mkStep("VERIFY", "WAITING_APPROVAL", { kind: "approval", allowed: { approve: true, retry: false, skip: false, evidence: false, attach: false, command: false } });
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ nextAction: { kind: "approval", stepKey: "VERIFY", code: "verify.approve", since: "2026-11-16T10:00:00.000Z", approval: b } }, stepsWith({ VERIFY: step })));
    const approve = vi.spyOn(api, "approveMigrationRunStep").mockResolvedValue(mkRun());
    wrap();
    await screen.findByText("Point of no return");
    fireEvent.change(screen.getByLabelText("Type tugra-1 to confirm"), { target: { value: "tugra-1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /stateful data may be lost/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve and pass the point of no return" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("run12345abcdef", "VERIFY", { boundHash: HASH, acks: [], confirmName: "tugra-1", acceptDataRisk: true }));
  });

  it("a countdown shows the time left on a timer wait", async () => {
    const notBefore = new Date(Date.now() + 5 * 60_000).toISOString();
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      mkRun({ currentStep: "DNS_PREPARE", nextAction: { kind: "timer", stepKey: "DNS_PREPARE", code: "dns-prepare.ttl-wait", since: "2026-11-16T10:00:00.000Z", notBefore } }, stepsWith({ DNS_PREPARE: mkStep("DNS_PREPARE", "WAITING_TIMER", { notBefore }) })),
    );
    wrap();
    await screen.findByRole("timer");
    expect(screen.getByRole("timer").textContent).toMatch(/remaining/);
  });

  it("an expired source session offers the token form, which never echoes the token", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ allowed: { ...mkRun().allowed, sourceSession: true }, nextAction: { kind: "session", stepKey: null, code: "run.session-expired", since: "2026-11-16T10:00:00.000Z" } }));
    const refresh = vi.spyOn(api, "migrationRunSourceSession").mockResolvedValue({ sessionId: "s2", expiresAt: "2026-11-16T12:00:00.000Z" });
    wrap();
    const input = await screen.findByLabelText("Source API token");
    fireEvent.change(input, { target: { value: "tok-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh the session" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith("run12345abcdef", { token: "tok-secret" }));
    await waitFor(() => expect((screen.getByLabelText("Source API token") as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain("tok-secret");
  });

  it("promoting a dry run whose session expired: the token form is offered and the fresh session id is sent to start", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      mkRun({ dryRun: true, status: "DRY_RUN_DONE", currentStep: null, allowed: { ...mkRun().allowed, start: true, pause: false, abort: false, sourceSession: true }, nextAction: { kind: "none", stepKey: null, code: "run.dry-run-done", since: "2026-11-16T10:00:00.000Z" } }),
    );
    vi.spyOn(api, "migrationRunSourceSession").mockResolvedValue({ sessionId: "s-fresh", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const start = vi.spyOn(api, "startMigrationRun").mockResolvedValue(mkRun({ id: "newrun1" }));
    wrap();
    fireEvent.change(await screen.findByLabelText("Source API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh the session" }));
    await screen.findByText(/A fresh source session is ready/);
    fireEvent.click(screen.getByRole("button", { name: "Start migration" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Promote to real run" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("run12345abcdef", { sessionId: "s-fresh" }));
  });

  it("attestations are per subject: attesting one subject leaves the other open and sends its subject", async () => {
    const step = mkStep("DATA_FINAL", "WAITING_OPERATOR", {
      kind: "operator",
      allowed: { approve: false, retry: false, skip: false, evidence: true, attach: false, command: false },
      gate: { passed: false, checks: [
        { id: "volume-copied", status: "unknown", code: "data-final.volume-unconfirmed", subject: "vol-a" },
        { id: "volume-copied", status: "unknown", code: "data-final.volume-unconfirmed", subject: "vol-b" },
      ] },
      evidence: { attestations: [{ checkId: "volume-copied", subject: "vol-a", byUserId: "u1", at: "2026-11-16T10:00:00.000Z" }], attachments: [] },
    });
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      mkRun({ currentStep: "DATA_FINAL", nextAction: { kind: "operator", stepKey: "DATA_FINAL", code: "data-final.run-migrator", since: "2026-11-16T10:00:00.000Z", attest: ["volume-copied"] } }, stepsWith({ DATA_FINAL: step })),
    );
    const attest = vi.spyOn(api, "attestMigrationRunStep").mockResolvedValue(mkRun());
    wrap();
    await screen.findByText("Recorded as attested by you.");
    expect(screen.getAllByText("Recorded as attested by you.")).toHaveLength(1);
    const buttons = screen.getAllByRole("button", { name: "I did this" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "I did this" }));
    await waitFor(() => expect(attest).toHaveBeenCalledWith("run12345abcdef", "DATA_FINAL", { checkId: "volume-copied", subject: "vol-b" }));
  });

  it("inventory findings get one attestation row each, with the finding's own subject; a mapping needs the plan item in its note", async () => {
    const finding = (container: string) => ({ id: `inventory-unlisted-db:${container}`, status: "fail" as const, code: "inventory.unlisted-db", subject: `host-1/${container}`, params: { host: "host-1", container, image: "mariadb:11", engine: "MARIADB", state: "running" }, attestable: ["inventory-excluded", "inventory-mapped"] });
    const step = mkStep("DATA_SEED", "WAITING_OPERATOR", {
      kind: "operator",
      allowed: { approve: false, retry: false, skip: false, evidence: true, attach: false, command: false },
      gate: { passed: false, checks: [finding("db-ghost-a"), finding("db-ghost-b")] },
    });
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      mkRun({ currentStep: "DATA_SEED", nextAction: { kind: "operator", stepKey: "DATA_SEED", code: "inventory.unlisted-db", since: "2026-11-16T10:00:00.000Z", attest: ["inventory-excluded", "inventory-mapped"] } }, stepsWith({ DATA_SEED: step })),
    );
    const attest = vi.spyOn(api, "attestMigrationRunStep").mockResolvedValue(mkRun());
    wrap();
    await screen.findByText("What I am waiting for");
    // two findings x (excluded, mapped) = four rows, each saying which container it is about
    const buttons = screen.getAllByRole("button", { name: "I did this" });
    expect(buttons).toHaveLength(4);
    expect(screen.getAllByText(/db-ghost-a/).length).toBeGreaterThanOrEqual(2);
    // the mapping buttons are disabled until the note names the plan item
    const disabled = buttons.filter((b) => (b as HTMLButtonElement).disabled);
    expect(disabled).toHaveLength(2);
    fireEvent.click(buttons.find((b) => !(b as HTMLButtonElement).disabled)!);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "I did this" }));
    await waitFor(() => expect(attest).toHaveBeenCalledWith("run12345abcdef", "DATA_SEED", { checkId: "inventory-excluded", subject: "host-1/db-ghost-a" }));
  });

  it("an aborted run whose host-loop freeze is still in effect offers the token-free unfreeze script from the report", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ status: "ABORTED", currentStep: null, allowed: { ...mkRun().allowed, abort: false, pause: false } }));
    vi.spyOn(api, "getMigrationRunReport").mockResolvedValue({
      runId: "run12345abcdef", generatedAt: "2026-11-16T10:00:00Z", status: "ABORTED", mode: "copy", topology: "two-box", dryRun: false, source: { kind: "coolify", host: "h" }, target: { serverId: "srv1", serverName: "tugra-1" },
      ponrAt: null, window: { estimatedSec: null, measuredSec: null }, steps: [], items: [], evidenceSummary: { "hub-verified": 0, "migrator-reported": 0, "operator-attested": 0 },
      manual: [{ code: "freeze.host-loop-unfreeze", params: { hosts: ["host-1"], count: 1 } }],
    });
    const mint = vi.spyOn(api, "migrationRunCommand").mockResolvedValue({ stepKey: "FREEZE", opId: "op1", expiresAt: "2026-11-16T10:00:00.000Z", command: "sh -s <<'EOF'\nunfreeze-script\nEOF", shownOnce: true });
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Get the unfreeze script" }));
    await screen.findByText(/unfreeze-script/);
    expect(mint).toHaveBeenCalledWith("run12345abcdef", "FREEZE", { reissue: false });
    expect(screen.queryByText(/Shown once/)).toBeNull(); // it carries no token: nothing to hide, nothing that expires
    expect(screen.queryByRole("button", { name: "Issue a new command" })).toBeNull();
  });

  it("the abort-is-safe banner is shown only while abort is actually allowed", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ status: "COMPLETED", currentStep: null, allowed: { ...mkRun().allowed, abort: false, pause: false } }));
    wrap();
    await screen.findByText("coolify.example.org → tugra-1");
    expect(screen.queryByText(/Before the point of no return you can abort/)).toBeNull();
  });

  it("gate checks carry an evidence badge and a link to the owner input that would resolve them", async () => {
    const step = mkStep("TLS_PREISSUE", "WAITING_OPERATOR", {
      gate: { passed: false, checks: [
        { id: "acme-email", status: "fail", code: "tls-preissue.acme-email-missing", ownerInput: "acmeEmail" },
        { id: "volumes", status: "pass", code: "step.passed", evidence: "migrator-reported", subject: "db-data" },
      ] },
    });
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ currentStep: "TLS_PREISSUE", nextAction: { kind: "gate", stepKey: "TLS_PREISSUE", code: "tls-preissue.blocked", since: "2026-11-16T10:00:00.000Z" } }, stepsWith({ TLS_PREISSUE: step })));
    wrap();
    await screen.findByText("What I am waiting for");
    expect(screen.getAllByText("Reported by the migrator").length).toBeGreaterThan(0);
    const link = screen.getAllByRole("link", { name: /Needs input: ACME certificate email/ })[0];
    expect(link.getAttribute("href")).toBe("#migration-run-inputs");
  });

  it("saves owner inputs through the inputs route", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun());
    const set = vi.spyOn(api, "setMigrationRunInputs").mockResolvedValue(mkRun());
    wrap();
    const email = await screen.findByLabelText("ACME certificate email");
    fireEvent.change(email, { target: { value: "ops@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Save inputs" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("run12345abcdef", { acmeEmail: "ops@example.org", allowBind: false, allowLiveShapeProbe: false, sourceController: "manual" }));
  });

  it("dry run: states it changed nothing, answers with the decision screen and promotes into the NEW run", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      mkRun({ dryRun: true, status: "DRY_RUN_DONE", currentStep: null, allowed: { ...mkRun().allowed, start: true, pause: false, abort: false }, nextAction: { kind: "none", stepKey: null, code: "run.dry-run-done", since: "2026-11-16T10:00:00.000Z" } },
        stepsWith({ PREFLIGHT: mkStep("PREFLIGHT", "PASSED", { progress: { done: 0, total: 1, unit: "item", dryRun: [{ code: "import.projection", level: "info", params: { apps: 3, databases: 1, services: 0 } }] } }) })),
    );
    const start = vi.spyOn(api, "startMigrationRun").mockResolvedValue(mkRun({ id: "newrun1" }));
    wrap();
    await screen.findByText("This is a dry run.");
    expect(screen.getByText(/writes nothing outside the run's own records/)).toBeTruthy();
    await screen.findByText("No problems found. You can start the real migration.");
    // the technical steps and events are not the primary view: they sit behind Details
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();
    expect(screen.queryByText("Events")).toBeNull();
    expect(screen.queryByRole("button", { name: "Promote to real run" })).toBeNull(); // the header does not carry a second start
    fireEvent.click(screen.getByRole("button", { name: "Start migration" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Promote to real run" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("run12345abcdef"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/import/runs/newrun1"));
  });

  it("dry run with a blocker: red, how to fix it, no start; Details opens the steps", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      mkRun({ dryRun: true, status: "DRY_RUN_DONE", currentStep: null, allowed: { ...mkRun().allowed, start: true, pause: false, abort: false }, nextAction: { kind: "none", stepKey: null, code: "run.dry-run-done", since: "2026-11-16T10:00:00.000Z" } },
        stepsWith({ PREFLIGHT: mkStep("PREFLIGHT", "PASSED", { progress: { done: 0, total: 0, unit: "item", dryRun: [{ code: "preflight.disk-low", level: "block", subject: "vol-a" }] } }) })),
    );
    wrap();
    await screen.findByText("1 problem stops the real migration");
    expect((screen.getByRole("button", { name: "Start migration" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/How to fix:/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByRole("list", { name: "Steps" })).toBeTruthy();
  });

  it("abort needs the run id typed, and is refused (with the reason) after the point of no return", async () => {
    const live = mkRun();
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(live);
    const abort = vi.spyOn(api, "abortMigrationRun").mockResolvedValue(mkRun({ status: "ABORTING" }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Abort run" }));
    const dialog = await screen.findByRole("dialog", { name: "Abort" });
    const confirmBtn = within(dialog).getByRole("button", { name: "Abort run" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type run12345abcdef to confirm"), { target: { value: "run12345abcdef" } });
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(abort).toHaveBeenCalledWith("run12345abcdef", { confirmName: "run12345abcdef" }));
  });

  it("after the point of no return: banner, no abort, reverse behind a typed name AND the data-loss acknowledgement", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(
      mkRun({ status: "WAITING", currentStep: "OBSERVE", ponrAt: "2026-11-16T10:30:00.000Z", allowed: { ...mkRun().allowed, abort: false, reverse: true } }),
    );
    const reverse = vi.spyOn(api, "reverseMigrationRun").mockResolvedValue(mkRun({ status: "REVERSING" }));
    wrap();
    await screen.findByText(/Point of no return reached 1?/i, { selector: "strong" });
    expect(screen.queryByRole("button", { name: "Abort run" })).toBeNull();
    expect(screen.getByText(/abort is refused/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reverse cutover" }));
    const dialog = await screen.findByRole("dialog", { name: "Reverse" });
    const confirmBtn = within(dialog).getByRole("button", { name: "Reverse cutover" }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText("Type run12345abcdef to confirm"), { target: { value: "run12345abcdef" } });
    expect(confirmBtn.disabled).toBe(true); // data-loss acknowledgement missing
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(reverse).toHaveBeenCalledWith("run12345abcdef", { confirmName: "run12345abcdef", acknowledgeDataLoss: true }));
  });

  it("cleanup with data needs the data-holding names listed", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ status: "ABORTED", currentStep: null, allowed: { ...mkRun().allowed, abort: false, pause: false, cleanup: true } }));
    const cleanup = vi.spyOn(api, "cleanupMigrationRun").mockResolvedValue(mkRun({ status: "ROLLING_BACK" }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Clean up" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean up" });
    fireEvent.change(within(dialog).getByLabelText("Type run12345abcdef to confirm"), { target: { value: "run12345abcdef" } });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    const btn = within(dialog).getByRole("button", { name: "Clean up" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type the name of each data-holding resource to remove, one per line"), { target: { value: "orders-db\n\nweb-data\n" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(cleanup).toHaveBeenCalledWith("run12345abcdef", { confirmName: "run12345abcdef", includeData: true, dataConfirmNames: ["orders-db", "web-data"] }));
  });

  it("decommission asks for the source host", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ mode: "takeover", status: "COMPLETED", currentStep: null, allowed: { ...mkRun().allowed, abort: false, pause: false, decommission: true } }));
    const dec = vi.spyOn(api, "decommissionMigrationRun").mockResolvedValue(mkRun());
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Stop the source" }));
    const dialog = await screen.findByRole("dialog", { name: "Decommission the source" });
    fireEvent.change(within(dialog).getByLabelText("Type coolify.example.org to confirm"), { target: { value: "coolify.example.org" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop the source" }));
    await waitFor(() => expect(dec).toHaveBeenCalledWith("run12345abcdef", { confirmName: "coolify.example.org" }));
  });

  it("failed run: names the failure, offers retry of the step", async () => {
    const step = mkStep("IMPORT", "FAILED", { lastError: "import.apply-failed", allowed: { approve: false, retry: true, skip: false, evidence: false, attach: false, command: false } });
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ status: "FAILED", currentStep: "IMPORT", failure: { step: "IMPORT", code: "import.apply-failed" }, nextAction: { kind: "failed", stepKey: "IMPORT", code: "import.apply-failed", since: "2026-11-16T10:00:00.000Z" } }, stepsWith({ IMPORT: step })));
    const retry = vi.spyOn(api, "retryMigrationRunStep").mockResolvedValue(mkRun());
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Retry this step" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("run12345abcdef", "IMPORT"));
  });

  it("pause asks first; resume is one click", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun());
    const pause = vi.spyOn(api, "pauseMigrationRun").mockResolvedValue(mkRun({ status: "PAUSED" }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith("run12345abcdef"));
  });

  it("opens the volume and cutover panels on demand, with the bypass warning, once their steps started", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ opId: "op9" }, stepsWith({ DATA_SEED: mkStep("DATA_SEED", "PASSED"), CUTOVER: mkStep("CUTOVER", "RUNNING") })));
    wrap();
    await screen.findByText("Volume transfers");
    expect(screen.queryByText("volumes-panel:op9")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Volume transfers" }));
    expect(screen.getByText("volumes-panel:op9")).toBeTruthy();
    expect(screen.getAllByText(/Read-only view of the operation's own panel/).length).toBe(1);
    // the embedded panels are inert: nothing inside them can act on the operation
    expect((screen.getByTestId("run-drawer-readonly") as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "SSL and DNS cutover details" }));
    expect(screen.getByText("cutover-panel:op9")).toBeTruthy();
  });

  it("loads the event log from the cursor and renders localized codes", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ eventSeq: 2 }));
    const ev = vi.spyOn(api, "getMigrationRunEvents").mockResolvedValue({
      events: [
        { seq: 1, at: "2026-11-16T10:00:00.000Z", stepKey: "PREFLIGHT", level: "info", code: "step.entered", params: null, actorId: null },
        { seq: 2, at: "2026-11-16T10:01:00.000Z", stepKey: "IMPORT", level: "error", code: "step.failed", params: null, actorId: null },
      ],
      lastSeq: 2,
      hasMore: false,
    });
    wrap();
    await screen.findByText("Step failed.");
    expect(ev).toHaveBeenCalledWith("run12345abcdef", 0, 200);
    const list = screen.getByRole("list", { name: "Events" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0].textContent).toContain("Step failed."); // newest first
    expect(rows[1].textContent).toContain("Step started.");
  });

  it("pages through the event log with the hub's cursor until there is no more", async () => {
    vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ eventSeq: 3 }));
    const e = (seq: number) => ({ seq, at: "2026-11-16T10:00:00.000Z", stepKey: null, level: "info" as const, code: "step.entered", params: null, actorId: null });
    const ev = vi.spyOn(api, "getMigrationRunEvents")
      .mockResolvedValueOnce({ events: [e(1), e(2)], lastSeq: 2, hasMore: true })
      .mockResolvedValueOnce({ events: [e(3)], lastSeq: 3, hasMore: false });
    wrap();
    await waitFor(() => expect(ev).toHaveBeenCalledTimes(2));
    expect(ev).toHaveBeenNthCalledWith(1, "run12345abcdef", 0, 200);
    expect(ev).toHaveBeenNthCalledWith(2, "run12345abcdef", 2, 200);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Events" })).getAllByRole("listitem")).toHaveLength(3));
  });

  it("a load failure shows the error state, not a spinner", async () => {
    vi.spyOn(api, "getMigrationRun").mockRejectedValue(new Error("boom"));
    wrap();
    await screen.findByText("Something went wrong");
  });

  describe("fleet runs", () => {
    const multi = (over: Partial<MigrationRunView> = {}, steps?: MigrationRunStepView[]) =>
      mkRun(
        {
          serverMap: { "host-a": "srv1", "host-b": "srv2" },
          targetServers: [
            { serverId: "srv1", serverName: "tugra-1", primary: true },
            { serverId: "srv2", serverName: "tugra-b", primary: false },
          ],
          campaign: "wave-1",
          ...over,
        },
        steps,
      );

    it("shows every target server, the placement, the campaign and the source version with its verdict", async () => {
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(multi({ sourceVersion: "4.9.0", sourceVersionVerdict: "newer", baselineAt: new Date().toISOString() }));
      wrap();
      await screen.findByText("coolify.example.org → tugra-1 +1");
      expect(screen.getByText("Target servers")).toBeTruthy();
      expect(screen.getAllByText("tugra-b").length).toBeGreaterThanOrEqual(2); // the facts and the placement card
      expect(screen.getByText("Placement")).toBeTruthy();
      expect(screen.getByText("host-b")).toBeTruthy();
      expect(screen.getByText("wave-1")).toBeTruthy();
      expect(screen.getByText("4.9.0")).toBeTruthy();
      expect(screen.getByText("Newer than tested")).toBeTruthy();
      expect(screen.getByText(/Recorded/)).toBeTruthy();
    });

    const preflightWith = (checks: Array<{ id: string; code: string; params: Record<string, string | number | string[]> }>) =>
      mkStep("PREFLIGHT", "PASSED", { gate: { passed: true, checks: checks.map((c) => ({ ...c, status: "pass" as const })) } });
    const withPreflight = (step: MigrationRunStepView) => stepsWith({ PREFLIGHT: step, IMPORT: mkStep("IMPORT", "PASSED") });

    it("shows a source host by the name PREFLIGHT recorded, and by its uuid only when the source gave no name", async () => {
      const pre = preflightWith([{ id: "preflight.hosts", code: "preflight.hosts-classified", params: { hosts: 2, empty: 0, osReported: 0, refs: ["host-a", "host-b"], names: ["Alpha box", ""] } }]);
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(multi({}, withPreflight(pre)));
      wrap();
      await screen.findByText("Placement");
      expect(screen.getByText("Alpha box")).toBeTruthy();
      expect(screen.queryByText("host-a")).toBeNull();
      expect(screen.getByText("host-b")).toBeTruthy(); // no name: the uuid is all there is
    });

    it("lists every held worker with what the run does with them (R26)", async () => {
      const names = Array.from({ length: 14 }, (_, i) => `worker-${i}`);
      const pre = preflightWith([{ id: "preflight.workers", code: "preflight.workers-held", params: { count: 14, items: names.slice(0, 10), workers: names, policy: "hold-dark" } }]);
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(multi({}, withPreflight(pre)));
      wrap();
      await screen.findByText(/14 apps serve no domain, so the run treats them as workers/);
      const list = screen.getByRole("list", { name: "Worker apps" });
      expect(within(list).getAllByRole("listitem")).toHaveLength(14); // not just the ten names of the sentence
      expect(within(list).getByText("worker-13")).toBeTruthy();
      expect(screen.getAllByText(/stay stopped until after the cutover/).length).toBeGreaterThanOrEqual(1);
    });

    it("says it plainly when the workers start next to the source or are left out, and shows no card without workers", async () => {
      const start = preflightWith([{ id: "preflight.workers", code: "preflight.workers-start-dark", params: { count: 1, items: ["w"], workers: ["w"], policy: "start-dark" } }]);
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(multi({}, withPreflight(start)));
      wrap();
      await screen.findByText(/may send mail or repeat jobs/);
      cleanup();
      qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const out = preflightWith([{ id: "preflight.workers", code: "preflight.workers-excluded", params: { count: 1, items: ["w"], workers: ["w"], policy: "exclude" } }]);
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(multi({}, withPreflight(out)));
      wrap();
      await screen.findByText(/are left out of this run/);
      cleanup();
      qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(multi({}, withPreflight(preflightWith([]))));
      wrap();
      await screen.findByText("Placement");
      expect(screen.queryByRole("list", { name: "Worker apps" })).toBeNull();
    });

    it("a single-target run has no placement card and says when the baseline is still missing", async () => {
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ sourceVersion: null, sourceVersionVerdict: "unknown" }));
      wrap();
      await screen.findByText("coolify.example.org → tugra-1");
      expect(screen.queryByText("Placement")).toBeNull();
      expect(screen.getByText("Not read yet")).toBeTruthy();
      expect(screen.getByText("Not known")).toBeTruthy();
      expect(screen.getByText(/Not recorded yet/)).toBeTruthy();
    });

    it("the point-of-no-return approval of a multi-host run asks for EVERY target server, sorted, then the source host", async () => {
      const b = binding({ confirm: "target-servers+source-host", ponr: true, requiresDataRisk: true, ttlSec: 1800 });
      const step = mkStep("VERIFY", "WAITING_APPROVAL", { kind: "approval", allowed: { approve: true, retry: false, skip: false, evidence: false, attach: false, command: false } });
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(multi({ nextAction: { kind: "approval", stepKey: "VERIFY", code: "verify.approve", since: "2026-11-16T10:00:00.000Z", approval: b } }, stepsWith({ VERIFY: step })));
      const approve = vi.spyOn(api, "approveMigrationRunStep").mockResolvedValue(mkRun());
      wrap();
      await screen.findByText("Point of no return");
      expect(screen.getByText(/places resources on several servers/)).toBeTruthy();
      const submit = screen.getByRole("button", { name: "Approve and pass the point of no return" }) as HTMLButtonElement;
      fireEvent.change(screen.getByLabelText("Type tugra-1 to confirm"), { target: { value: "tugra-1" } });
      fireEvent.change(screen.getByLabelText("Type coolify.example.org to confirm"), { target: { value: "coolify.example.org" } });
      fireEvent.click(screen.getByRole("checkbox", { name: /stateful data may be lost/ }));
      // one server is still missing: nothing can be sent that names only some of the hosts
      expect(submit.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Type tugra-b to confirm"), { target: { value: "tugra-b" } });
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);
      await waitFor(() => expect(approve).toHaveBeenCalledWith("run12345abcdef", "VERIFY", { boundHash: HASH, acks: [], confirmName: "tugra-1, tugra-b coolify.example.org", acceptDataRisk: true }));
    });

    it("a host-loop run offers the script of what the step waits for: the inventory first", async () => {
      const step = mkStep("DATA_SEED", "WAITING_OPERATOR", {
        kind: "operator",
        wait: { kind: "operator", code: "data-seed.host-inventory-run", offersCommand: true, commandKind: "inventory" },
        allowed: { approve: false, retry: false, skip: false, evidence: false, attach: false, command: true },
      });
      const base = mkRun();
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(
        mkRun({ currentStep: "DATA_SEED", options: { ...base.options, sourceRunner: "coolify-host-loop" }, nextAction: { kind: "operator", stepKey: "DATA_SEED", code: "data-seed.host-inventory-run", since: "2026-11-16T10:00:00.000Z", offersCommand: true } }, stepsWith({ DATA_SEED: step })),
      );
      const mint = vi.spyOn(api, "migrationRunCommand").mockResolvedValue({ stepKey: "DATA_SEED", kind: "inventory", opId: "op1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), command: "sh -s <<'EOF'\ninventory-script\nEOF", shownOnce: true });
      wrap();
      fireEvent.click(await screen.findByRole("button", { name: "Get the inventory script" }));
      await screen.findByText(/inventory-script/);
      // the hub picks the command from what the step waits for, so the page sends no kind of its own
      expect(mint).toHaveBeenCalledWith("run12345abcdef", "DATA_SEED", { reissue: false });
      expect(screen.getByText("Run the inventory on the Coolify host")).toBeTruthy();
    });

    it("the host-loop script of a data step is worded as the Coolify-host script", async () => {
      const step = mkStep("DATA_FINAL", "WAITING_OPERATOR", { kind: "operator", allowed: { approve: false, retry: false, skip: false, evidence: false, attach: false, command: true } });
      const base = mkRun();
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(
        mkRun({ currentStep: "DATA_FINAL", options: { ...base.options, sourceRunner: "coolify-host-loop" }, nextAction: { kind: "operator", stepKey: "DATA_FINAL", code: "data-final.run-migrator", since: "2026-11-16T10:00:00.000Z", offersCommand: true } }, stepsWith({ DATA_FINAL: step })),
      );
      vi.spyOn(api, "migrationRunCommand").mockResolvedValue({ stepKey: "DATA_FINAL", kind: "host-loop", opId: "op1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), command: "host-loop-script", shownOnce: true });
      wrap();
      fireEvent.click(await screen.findByRole("button", { name: "Get the host-loop script" }));
      await screen.findByText("host-loop-script");
      expect(screen.getByText("Run on the Coolify host")).toBeTruthy();
      expect(screen.getByText(/loops over the source hosts/)).toBeTruthy();
      expect(screen.getByText(/Shown once/)).toBeTruthy(); // this script carries the live token
    });

    it("a manual-DNS host lists the exact records to enter with a copy button, and what the resolvers show", async () => {
      const step = mkStep("CUTOVER", "WAITING_OPERATOR", {
        kind: "operator",
        allowed: { approve: false, retry: false, skip: false, evidence: true, attach: false, command: false },
        gate: { passed: false, checks: [{ id: "cutover.manual-dns-switched", status: "warn", code: "cutover.release-manual-dns", subject: "app-a.example.test", params: { host: "app-a.example.test", records: ["app-a.example.test A 203.0.113.10"], observed: "198.51.100.7" } }] },
      });
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(
        mkRun({ currentStep: "CUTOVER", nextAction: { kind: "operator", stepKey: "CUTOVER", code: "cutover.manual-dns", since: "2026-11-16T10:00:00.000Z", attest: ["cutover.manual-dns-switched"] } }, stepsWith({ CUTOVER: step })),
      );
      wrap();
      await screen.findByText("Records to enter");
      expect(screen.getAllByText("app-a.example.test A 203.0.113.10").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("The resolvers show: 198.51.100.7")).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Copy" }).length).toBeGreaterThanOrEqual(1);
    });

    it("the report names every target server and counts the new evidence kinds", async () => {
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(multi({ status: "COMPLETED", currentStep: null, allowed: { ...mkRun().allowed, abort: false, pause: false } }));
      vi.spyOn(api, "getMigrationRunReport").mockResolvedValue({
        runId: "run12345abcdef", generatedAt: "2026-11-16T10:00:00Z", status: "COMPLETED", mode: "copy", topology: "two-box", dryRun: false, source: { kind: "coolify", host: "h", version: "4.5.0" },
        target: { serverId: "srv1", serverName: "tugra-1" }, targets: [{ serverId: "srv1", serverName: "tugra-1" }, { serverId: "srv2", serverName: "tugra-b" }], campaign: "wave-1",
        ponrAt: null, window: { estimatedSec: null, measuredSec: null }, steps: [], items: [],
        evidenceSummary: { "hub-verified": 2, "migrator-reported": 0, "operator-attested": 0, "source-api-reported": 3, "host-loop-reported": 0 }, manual: [],
      });
      wrap();
      await screen.findByText("Target servers: tugra-1, tugra-b");
      expect(screen.getByText("Source version: 4.5.0")).toBeTruthy();
      expect(screen.getByText("Campaign: wave-1")).toBeTruthy();
      expect(screen.getByText("Reported by the source API")).toBeTruthy();
      expect(screen.queryByText("Reported by the host script")).toBeNull(); // a kind the run never relied on stays out
    });

    it("the owner-input card answers the fleet policies and sends only the ones that changed", async () => {
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun());
      const save = vi.spyOn(api, "setMigrationRunInputs").mockResolvedValue(mkRun());
      wrap();
      fireEvent.change(await screen.findByLabelText("Hosts that use the source's object storage"), { target: { value: "mirror" } });
      // no control is offered for an input no step reads
      expect(screen.queryByLabelText("Write gap you accept (minutes)")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Save inputs" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const body = save.mock.calls[0][1];
      expect(body).toMatchObject({ minioPolicy: "mirror" });
      expect(body).not.toHaveProperty("tickGapAcceptMinutes");
      expect(body).not.toHaveProperty("workerPolicy");
      expect(body).not.toHaveProperty("unlistedDbPolicy");
    });
  });

  describe("held workers and image pins", () => {
    const hints = { imagePins: [{ image: "repo/app:latest", scope: "", digest: `sha256:${"a".repeat(64)}`, evidence: "operator-attested" }], workerMarks: [{ itemRef: "app:host-a:queue", role: "job-runner" as const }], warningAcks: [] as string[] };
    const open = async () => {
      fireEvent.click(await screen.findByText("Show and edit"));
      await screen.findByText("Job runners and web apps");
    };

    it("loads the recorded facts only when opened, and records a job runner mark and an image digest", async () => {
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun());
      const get = vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints);
      const marks = vi.spyOn(api, "setMigrationRunWorkerMarks").mockResolvedValue({ ...hints, workerMarks: [...hints.workerMarks, { itemRef: "app:host-a:cron", role: "job-runner" }] });
      const pins = vi.spyOn(api, "setMigrationRunImagePins").mockResolvedValue(hints);
      wrap();
      await screen.findByText("Exact images, held workers and image pins");
      expect(get).not.toHaveBeenCalled();
      await open();
      expect(get).toHaveBeenCalledWith("run12345abcdef");
      expect(screen.getByText("app:host-a:queue")).toBeTruthy();
      expect(screen.getByText("repo/app:latest")).toBeTruthy();

      // a mark must name a plan app item
      const item = screen.getByLabelText("Plan item (app:host:name)");
      fireEvent.change(item, { target: { value: "nonsense" } });
      expect((screen.getByRole("button", { name: "Save mark" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(item, { target: { value: "app:host-a:cron" } });
      fireEvent.click(screen.getByRole("button", { name: "Save mark" }));
      await waitFor(() => expect(marks).toHaveBeenCalledWith("run12345abcdef", { marks: [{ itemRef: "app:host-a:cron", role: "job-runner" }] }));

      // a digest must be sha256 plus 64 lower-case hex characters
      fireEvent.change(screen.getByLabelText("Image as the plan shows it"), { target: { value: "repo/search:latest" } });
      fireEvent.change(screen.getByLabelText("Digest (sha256:...)"), { target: { value: "sha256:short" } });
      expect((screen.getByRole("button", { name: "Save digest" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Digest (sha256:...)"), { target: { value: `sha256:${"b".repeat(64)}` } });
      fireEvent.click(screen.getByRole("button", { name: "Save digest" }));
      await waitFor(() => expect(pins).toHaveBeenCalledWith("run12345abcdef", { pins: [{ image: "repo/search:latest", scope: "", digest: `sha256:${"b".repeat(64)}`, evidence: "operator-attested" }] }));
    });

    it("removes a mark with a null role, and is read-only once the run is past the point of no return", async () => {
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun());
      vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints);
      const marks = vi.spyOn(api, "setMigrationRunWorkerMarks").mockResolvedValue({ ...hints, workerMarks: [] });
      wrap();
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Remove the mark of app:host-a:queue" }));
      await waitFor(() => expect(marks).toHaveBeenCalledWith("run12345abcdef", { marks: [{ itemRef: "app:host-a:queue", role: null }] }));
      cleanup();
      qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints);
      vi.spyOn(api, "getMigrationRun").mockResolvedValue(mkRun({ ponrAt: "2026-11-16T10:00:00.000Z" }));
      wrap();
      await open();
      expect(screen.getByText(/can no longer take these facts/)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Remove the mark of app:host-a:queue" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Save mark" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
