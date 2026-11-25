import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { ImportWizard } from "./import-wizard";
import { api, ApiError } from "../lib/api";
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
    window.history.replaceState(null, "", "/"); // the wizard mirrors the running op into ?op=
    window.localStorage.clear(); // the last connected address is remembered between visits
    window.sessionStorage.clear();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The post-import cutover step reads these on mount once the timeline settles; default to "not set up yet".
    vi.spyOn(api, "getCutover").mockRejectedValue(new ApiError(404, "not found"));
    vi.spyOn(api, "listDnsCredentials").mockResolvedValue([]);
    vi.spyOn(api, "importEgressIp").mockResolvedValue({ ip: null, source: "unknown" });
    // The connection test fires as soon as a URL and token are filled; default to a source that cannot say more than "reachable".
    vi.spyOn(api, "importTest").mockResolvedValue({ ok: true, apps: null, databases: null, services: null, sensitive: null });
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team One" }] as never);
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv1", name: "Server A", teamId: "t1", status: "ONLINE", clusterId: null, tags: [] }] as never);
    // The post-import MigrateDataCard reads this on mount once the timeline settles — default to "no live token".
    vi.spyOn(api, "getMigrateCommand").mockResolvedValue({ opId: "op1", active: false, expiresAt: null, commandTemplate: "run on the source host" });
    // The streamed-volume panel polls this once the timeline settles — default to "the hub has the stream off" (renders nothing).
    vi.spyOn(api, "getOpVolumes").mockResolvedValue({ volumes: [], tokenExpiresAt: null, enabled: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it("connect → preview → apply onto a target → live timeline", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
    wrap(<ImportWizard />);

    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
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

  it("prefills the Coolify address from the same-tab handoff only, never from ?url=, and ignores anything that is not http(s)", async () => {
    window.history.replaceState(null, "", "/import?url=https%3A%2F%2Fattacker.example.com");
    const none = wrap(<ImportWizard />);
    expect(((await screen.findByLabelText("Coolify URL")) as HTMLInputElement).value).toBe("");
    none.unmount();
    window.history.replaceState(null, "", "/import");
    window.sessionStorage.setItem("tugra.import.prefillUrl", "https://coolify.example.com");
    const first = wrap(<ImportWizard />);
    expect(((await screen.findByLabelText("Coolify URL")) as HTMLInputElement).value).toBe("https://coolify.example.com");
    expect(window.sessionStorage.getItem("tugra.import.prefillUrl")).toBeNull();
    first.unmount();
    window.sessionStorage.setItem("tugra.import.prefillUrl", "javascript:alert(1)");
    wrap(<ImportWizard />);
    expect(((await screen.findByLabelText("Coolify URL")) as HTMLInputElement).value).toBe("");
  });

  const fillCoolify = async () => {
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.blur(screen.getByLabelText("Coolify URL"));
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok-12345678" } });
  };
  const refusedByIpList = () => vi.spyOn(api, "importTest").mockResolvedValue({ ok: false, code: "allowed-ips", message: 'could not reach Coolify: Coolify API error 403: "You are not allowed to access the API."' });

  it("shows no Allowed IPs help up front, nor when the token simply works", async () => {
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    expect(screen.queryByTestId("egress-ip")).toBeNull();
    await fillCoolify();
    await waitFor(() => expect(api.importTest).toHaveBeenCalled());
    await screen.findByTestId("connection-test");
    expect(screen.queryByTestId("egress-ip")).toBeNull();
  });

  it("shows the hub's egress IP only after Coolify names its Allowed IPs list, with a copy button and the proxy note", async () => {
    vi.spyOn(api, "importEgressIp").mockResolvedValue({ ip: "203.0.113.7", source: "server" });
    refusedByIpList();
    wrap(<ImportWizard />);
    await fillCoolify();
    const box = await screen.findByTestId("egress-ip");
    expect(within(box).getByText("203.0.113.7")).toBeTruthy();
    expect(within(box).getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(box.textContent).toMatch(/Allowed IPs/);
    expect(box.textContent).toMatch(/reverse proxy or Cloudflare/);
    expect(box.textContent).toMatch(/Taken from the public address of the server this hub runs on/);
    expect(screen.getByRole("alert").textContent).toBe("Coolify does not allow this hub's address.");
  });

  it("says plainly when the hub cannot tell its address, and when the operator set it", async () => {
    refusedByIpList();
    wrap(<ImportWizard />);
    await fillCoolify();
    const unknown = await screen.findByTestId("egress-ip");
    expect(unknown.textContent).toMatch(/the address Coolify sees this hub connect from/);
    expect(unknown.textContent).toMatch(/IMPORT_EGRESS_IP/);
    expect(within(unknown).queryByRole("button", { name: "Copy address" })).toBeNull();
    cleanup();
    vi.spyOn(api, "importEgressIp").mockResolvedValue({ ip: "198.51.100.4", source: "env" });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    wrap(<ImportWizard />);
    await fillCoolify();
    const env = await screen.findByTestId("egress-ip");
    expect(within(env).getByText("198.51.100.4")).toBeTruthy();
    expect(env.textContent).toMatch(/Set by the operator/);
  });

  it("a failed lookup does not block connecting and is not shown as an address", async () => {
    vi.spyOn(api, "importEgressIp").mockRejectedValue(new ApiError(500, "boom"));
    refusedByIpList();
    wrap(<ImportWizard />);
    await fillCoolify();
    const box = await screen.findByTestId("egress-ip");
    expect(box.textContent).toMatch(/could not be asked for its address/);
    expect(screen.getByRole("button", { name: "Connect & preview" })).toBeTruthy();
  });

  it("other refusals show their own single line and never the Allowed IPs box", async () => {
    for (const [code, line] of [
      ["api-disabled", "The Coolify API is off. Turn it on under Settings, Advanced."],
      ["scoped-token", "This token covers only some projects. Create one for the whole team."],
      ["rate-limited", "Coolify is limiting requests. Wait a minute and try again."],
      ["forbidden", "Coolify refused the token."],
    ] as const) {
      cleanup();
      qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.spyOn(api, "importTest").mockResolvedValue({ ok: false, code, message: "raw" });
      wrap(<ImportWizard />);
      await fillCoolify();
      expect((await screen.findByRole("alert")).textContent).toBe(line);
      expect(screen.queryByTestId("egress-ip")).toBeNull();
    }
  }, 30_000);

  it("shows the one-line connection test and fills the source team label from the team, until the person types their own", async () => {
    vi.spyOn(api, "importTest").mockResolvedValue({ ok: true, team: "Acme Team", suggestedLabel: "acme-team", apps: 19, databases: 10, services: 0, sensitive: true });
    wrap(<ImportWizard />);
    await fillCoolify();
    const line = await screen.findByTestId("connection-test");
    expect(line.textContent).toBe("✓ Acme Team, 19 apps, 10 databases · read:sensitive");
    await waitFor(() => expect((screen.getByLabelText("Source team label") as HTMLInputElement).value).toBe("acme-team"));
    // a label the person typed is kept when the token is tested again
    fireEvent.change(screen.getByLabelText("Source team label"), { target: { value: "mine" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok-87654321" } });
    await waitFor(() => expect(api.importTest).toHaveBeenCalledTimes(2));
    await screen.findByTestId("connection-test");
    expect((screen.getByLabelText("Source team label") as HTMLInputElement).value).toBe("mine");
  });

  it("warns in one line when the token cannot read sensitive values", async () => {
    vi.spyOn(api, "importTest").mockResolvedValue({ ok: true, team: "Acme", apps: 1, databases: 0, services: 0, sensitive: false });
    wrap(<ImportWizard />);
    await fillCoolify();
    const line = await screen.findByTestId("connection-test");
    expect(line.textContent).toContain("✓ Acme, 1 app, 0 databases · no read:sensitive");
    expect(line.textContent).toContain("Create a token with read:sensitive");
  });

  it("does not test until a URL and a token are filled, and sends the token to the test endpoint only", async () => {
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    await new Promise((r) => setTimeout(r, 900));
    expect(api.importTest).not.toHaveBeenCalled();
    // a token pasted before the address field was left is not sent to a half-typed address
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok-12345678" } });
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.exampl" } });
    await new Promise((r) => setTimeout(r, 900));
    expect(api.importTest).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.blur(screen.getByLabelText("Coolify URL"));
    await waitFor(() => expect(api.importTest).toHaveBeenCalledWith({ sourceKind: "coolify", teamId: "t1", baseUrl: "https://coolify.example.com", token: "tok-12345678" }));
  });

  it("says up front what is needed, links the token page of the typed address, and links the servers page", async () => {
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    expect(screen.getByTestId("import-needs").textContent).toBe("You need your Coolify address and an API token with read and read:sensitive.");
    expect(screen.queryByRole("link", { name: "Open the token page in Coolify" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com/some/path" } });
    expect(screen.getByRole("link", { name: "Open the token page in Coolify" }).getAttribute("href")).toBe("https://coolify.example.com/security/api-tokens");
    expect(screen.getByRole("link", { name: "Read this Coolify" }).getAttribute("href")).toBe("/import/coolify-host");
    expect(screen.getByRole("link", { name: "Open your servers" }).getAttribute("href")).toBe("/servers");
  });

  it("remembers the address of the last connection (never the token) and prefills it next time", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("Import preview");
    expect(window.localStorage.getItem("tugra.import.lastUrl.coolify")).toBe("https://coolify.example.com");
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain("tok-secret");
    cleanup();
    wrap(<ImportWizard />);
    expect(((await screen.findByLabelText("Coolify URL")) as HTMLInputElement).value).toBe("https://coolify.example.com");
  });

  it("opens on the source, address and server it was sent from, with a note about where the user came from", async () => {
    window.sessionStorage.setItem("tugra.import.focus", JSON.stringify({ kind: "dokploy", address: "https://dok.example.com", fromServerName: "Box 1" }));
    wrap(<ImportWizard />);
    expect(((await screen.findByLabelText("Dokploy URL")) as HTMLInputElement).value).toBe("https://dok.example.com");
    expect(screen.getByText("Moving what runs on Box 1. Pick it on the next step.")).toBeTruthy();
    expect(screen.getByTestId("import-needs").textContent).toMatch(/Dokploy address/);
    expect(window.sessionStorage.getItem("tugra.import.focus")).toBeNull(); // read once
  });

  it("starts the first step on the one source server it was sent to, already placed on the Tugra server it is connected as", async () => {
    const scoped: ImportPlan = {
      ...plan,
      items: [
        { itemRef: "app:srvA:web", kind: "app", name: "web-app", proposed: {}, risks: [], dependsOn: [] },
        { itemRef: "app:srvB:api", kind: "app", name: "api-app", proposed: {}, risks: [], dependsOn: [] },
      ],
      mapping: { features: ["mapping-v1"] },
      preflight: { hosts: [{ ref: "srvA", name: "Box A" }, { ref: "srvB", name: "Box B" }] },
    } as unknown as ImportPlan;
    window.sessionStorage.setItem("tugra.import.focus", JSON.stringify({ kind: "coolify", sourceServerUuid: "srvB", targetServerId: "srv1", targetTeamId: "t1" }));
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(scoped);
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    const boxB = (await screen.findByRole("checkbox", { name: /Box B/ })) as HTMLInputElement;
    expect(boxB.checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Box A/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("keeps the token hint to one line and the rules behind More", async () => {
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    expect(screen.getByText("Coolify, Keys & Tokens, API token with read and read:sensitive.")).toBeTruthy();
    const more = screen.getAllByText("More").map((m) => m.closest("details") as HTMLDetailsElement).find((d) => /team admin or owner/.test(d.textContent ?? "")) as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.textContent).toMatch(/team admin or owner/);
    expect(more.textContent).toMatch(/200 requests a minute/);
  });

  it("shows the hub's refusal as one line with the single cause and keeps the raw message under Details", async () => {
    vi.spyOn(api, "importEgressIp").mockResolvedValue({ ip: "203.0.113.7", source: "server" });
    const msg = 'could not reach Coolify: Coolify API error 403: "You are not allowed to access the API."';
    vi.spyOn(api, "importConnect").mockRejectedValue(new ApiError(400, msg, "allowed-ips"));
    wrap(<ImportWizard />);
    await fillCoolify();
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Coolify does not allow this hub's address.");
    expect((await screen.findByTestId("egress-ip")).textContent).toContain("203.0.113.7");
    expect(screen.getByTestId("connection-failure").textContent).toContain("You are not allowed to access the API.");
  });

  it("the Allowed IPs help is Coolify only: switching to Dokploy drops it", async () => {
    refusedByIpList();
    wrap(<ImportWizard />);
    await fillCoolify();
    await screen.findByTestId("egress-ip");
    fireEvent.click(screen.getByRole("radio", { name: "Dokploy" }));
    await waitFor(() => expect(screen.queryByTestId("egress-ip")).toBeNull());
  });

  it("offers the guided run next to the manual apply, which stays", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    wrap(<ImportWizard />);

    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("Import preview");

    expect(screen.getByRole("button", { name: "Run guided migration" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import to Tugra" })).toBeTruthy(); // the manual flow is untouched
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

    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
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

    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
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

  // ── streamed volume copy: commands, toggles, PostgreSQL data mode ─────────────────────────────────────────
  const goToTimeline = async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("DONE");
  };
  const TOKEN = "tugra_mig_" + "x".repeat(43);
  const base = `curl -fsSL https://hub.example.com/install/migrator.sh | TUGRA_MIGRATION_TOKEN=${TOKEN} sh -s -- --hub https://hub.example.com`;

  it("move data: shows the dry-run, copy and resume commands; the toggles append their flags and warn plainly", async () => {
    vi.spyOn(api, "mintMigrationToken").mockResolvedValue({
      opId: "op1", token: TOKEN, command: base, expiresAt: "2026-02-01T00:00:00.000Z",
      commands: { dryRun: `${base} --arms all --dry-run`, run: `${base} --arms all`, resume: `${base} --arms all --hub-outage-wait 30m` },
    });
    await goToTimeline();
    fireEvent.click(screen.getByRole("button", { name: "Generate migration command" }));
    await screen.findByText("1. Dry run (changes nothing)");
    expect(screen.getByText("2. Copy")).toBeTruthy();
    expect(screen.getByText("3. Resume after an interruption")).toBeTruthy();
    expect(screen.getByText(`${base} --arms all --dry-run`)).toBeTruthy();
    // toggles: off by default, flags appear on ALL three commands when on
    expect(screen.queryByText(/--stop-source$/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Stop each source container for me/));
    expect(screen.getByText(`${base} --arms all --stop-source`)).toBeTruthy();
    expect(screen.getByText(`${base} --arms all --hub-outage-wait 30m --stop-source`)).toBeTruthy();
    expect(screen.getByText(/Stops ONLY the source container of each volume/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Include host bind mounts/));
    expect(screen.getByText(`${base} --arms all --stop-source --allow-bind`)).toBeTruthy();
    expect(screen.getByText(/System, Docker and Coolify secret paths stay refused/)).toBeTruthy();
    // the token never rides an argv flag
    expect(document.body.textContent).not.toContain("--token");
  });

  it("move data: an already-minted token shows the placeholder commands, never a credential", async () => {
    vi.spyOn(api, "getMigrateCommand").mockResolvedValue({
      opId: "op1", active: true, expiresAt: "2026-02-01T00:00:00.000Z", commandTemplate: "legacy template <TOKEN>",
      commandsTemplate: { dryRun: "tpl <TOKEN> --arms all --dry-run", run: "tpl <TOKEN> --arms all", resume: "tpl <TOKEN> --arms all --hub-outage-wait 30m" },
    });
    await goToTimeline();
    await screen.findByText("tpl <TOKEN> --arms all --dry-run");
    expect(document.body.textContent).not.toContain("tugra_mig_");
  });

  describe("PostgreSQL data mode (Logical dump | Volume copy)", () => {
    const pgPlan: ImportPlan = {
      ...plan,
      totals: { apps: 1, databases: 1, volumes: 0, blockers: 0 },
      items: [
        plan.items[0],
        { itemRef: "database:srv:pg", kind: "database", name: "orders-db", proposed: { engine: "POSTGRES", version: "16", image: "postgres:16-alpine" }, risks: [], dependsOn: [] },
        { itemRef: "database:srv:my", kind: "database", name: "shop-db", proposed: { engine: "MYSQL" }, risks: [], dependsOn: [] },
      ],
    };
    const volPlan: ImportPlan = {
      ...pgPlan,
      planHash: "b".repeat(32),
      items: pgPlan.items.map((it) => (it.itemRef === "database:srv:pg" ? { ...it, proposed: { ...it.proposed, dataMode: "volume" } } : it)),
    };

    it("offers it for PostgreSQL only; choosing Volume copy re-plans with the choice, explains the locked values, and apply carries it", async () => {
      vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
      const planSpy = vi.spyOn(api, "importPlan").mockResolvedValueOnce(pgPlan).mockResolvedValue(volPlan);
      const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
      vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
      wrap(<ImportWizard />);
      await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
      fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
      fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
      const group = await screen.findByRole("radiogroup", { name: "Data mode: orders-db" });
      expect(screen.queryByRole("radiogroup", { name: "Data mode: shop-db" })).toBeNull(); // MySQL stays logical
      expect(within(group).getByRole("radio", { name: "Logical dump" }).getAttribute("aria-checked")).toBe("true");

      fireEvent.click(within(group).getByRole("radio", { name: "Volume copy" }));
      await waitFor(() => expect(planSpy).toHaveBeenLastCalledWith({ sourceKind: "coolify", sessionId: "s1", dbDataModes: { "database:srv:pg": "volume" } }));
      await screen.findByText(/Volume copy keeps the source image, its PostgreSQL major and the carried database and user names/);
      expect(screen.getByRole("radio", { name: "Volume copy" }).getAttribute("aria-checked")).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
      await waitFor(() => expect(applySpy).toHaveBeenCalledWith({ sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", planHash: "b".repeat(32), dbDataModes: { "database:srv:pg": "volume" } }));
    });

    it("switching back to the logical dump drops the choice from the next plan request", async () => {
      vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
      const planSpy = vi.spyOn(api, "importPlan").mockResolvedValueOnce(pgPlan).mockResolvedValueOnce(volPlan).mockResolvedValue(pgPlan);
      wrap(<ImportWizard />);
      await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
      fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
      fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
      const group = await screen.findByRole("radiogroup", { name: "Data mode: orders-db" });
      fireEvent.click(within(group).getByRole("radio", { name: "Volume copy" }));
      await screen.findByText(/Volume copy keeps the source image/);
      fireEvent.click(screen.getByRole("radio", { name: "Logical dump" }));
      await waitFor(() => expect(planSpy).toHaveBeenLastCalledWith({ sourceKind: "coolify", sessionId: "s1" }));
    });
  });

  it("keeps the connect button disabled until url + token are filled", async () => {
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    const btn = screen.getByRole("button", { name: "Connect & preview" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ── G3-C: Dokploy source, coverage card, timeline "Not carried" ──────────────────────────────────────────
  const connectDokploy = async () => {
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
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
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("DONE");
    expect(screen.getByText("Your databases were recreated empty. Generate a one-time command and run it on your source (Coolify) host to copy their data. It works once and expires.")).toBeTruthy();
    expect(screen.getByText(/instead of the old Coolify one/)).toBeTruthy();
  });

  it("switching source clears the URL and token; the source picker is a radiogroup", async () => {
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Coolify" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "coolify-token" } });
    fireEvent.click(screen.getByRole("radio", { name: "Dokploy" }));
    expect(screen.getByRole("radio", { name: "Dokploy" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Dokploy URL") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Paste an API key to see what will move.")).toBeTruthy();
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
          { field: "customLabels", level: "info", reason: "read when you apply", reasonCode: "custom_labels_deferred" },
        ] }] },
      },
    };
    const planSpy = vi.spyOn(api, "importPlan").mockResolvedValue(covered);
    const first = wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("What isn't carried over");
    expect(screen.getByText("Not carried (3)")).toBeTruthy();
    expect((screen.getByText("Not carried (3)").closest("details") as HTMLDetailsElement).open).toBe(false); // collapsed
    expect(screen.getByText("Review")).toBeTruthy(); // warn row: text cue, not colour alone
    expect(screen.getAllByText("Note")).toHaveLength(2);
    expect(screen.getByText(/the source gated this app with HTTP basic auth/)).toBeTruthy(); // no code: the hub's English text is the fallback
    expect(screen.getByText(/read when you apply: Tugra-safe labels are carried/)).toBeTruthy(); // a code: the translated text
    expect(screen.getByText("Custom labels and Dockerfile text are read when you apply.")).toBeTruthy();
    first.unmount();

    planSpy.mockResolvedValue(plan);
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("Import preview");
    expect(screen.queryByText("What isn't carried over")).toBeNull();
  });

  it("the 'read when you apply' note is not shown for a plan without a deferred row (a Dokploy plan has none)", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue({
      ...plan,
      sourceKind: "dokploy",
      preflight: {
        databases: [], services: [], appsWithVolumeData: 0,
        coverage: { apps: [{ itemRef: "app:srv:web", name: "web-app", notCarried: [{ field: "customLabels", level: "info", reason: "x", reasonCode: "dokploy_swarm_labels" }] }] },
      },
    });
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("What isn't carried over");
    expect(screen.getByText(/Dokploy Swarm service labels are not carried/)).toBeTruthy();
    expect(screen.queryByText("Custom labels and Dockerfile text are read when you apply.")).toBeNull();
  });

  it("timeline: a task with postCreate/ingress unmapped shows 'Not carried (n)' + Applied; a task without renders no disclosure", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue({
      ...settledOp,
      totals: { ...settledOp.totals, total: 2, done: 2 },
      tasks: [
        { ...settledOp.tasks[0], postCreate: { applied: ["build", "customLabels"], unmapped: [{ field: "customLabel:traefik.enable", reason: "in the reserved traefik.* namespace", reasonCode: "label_reserved_traefik" }] }, ingress: { applied: [], unmapped: [{ field: "ports", reason: "Tugra allows at most 20 extra published ports", reasonCode: "ports_limit", reasonParams: { max: 20 } }] } },
        { ...settledOp.tasks[0], itemRef: "app:srv:plain", name: "plain-app" },
      ],
    });
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("Not carried (2)");
    expect(screen.getByText(/customLabel:traefik\.enable/)).toBeTruthy();
    expect(screen.getByText("Applied: build, customLabels")).toBeTruthy();
    expect(screen.getByText(/in the reserved traefik\.\* namespace \(owned by Tugra's ingress routing/)).toBeTruthy(); // translated by code
    expect(screen.getByText(/Tugra allows at most 20 extra published ports/)).toBeTruthy(); // params substituted
    expect(screen.getAllByText(/^Not carried \(/)).toHaveLength(1); // only the task with something unmapped
  });
  it("a settled op with a created app shows the SSL/DNS cutover step, and ?op= reopens the timeline after a reload", async () => {
    vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
    window.history.replaceState(null, "", "/?op=op1");
    wrap(<ImportWizard />);
    await screen.findByText("web-app");
    await screen.findByText("SSL & DNS cutover");
    expect(await screen.findByRole("button", { name: "Set up cutover" })).toBeTruthy(); // getCutover 404 → not set up yet
  });
});

describe("ImportWizard — editable mapping", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/"); // the wizard mirrors the running op into ?op=
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "getCutover").mockRejectedValue(new ApiError(404, "not found"));
    vi.spyOn(api, "listDnsCredentials").mockResolvedValue([]);
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Team One" }, { id: "t2", name: "Team Two" }] as never);
    vi.spyOn(api, "listServers").mockResolvedValue([
      { id: "srv1", name: "Server A", teamId: "t1", status: "ONLINE", clusterId: null, tags: [], canWrite: true },
      { id: "srv2", name: "Server B", teamId: "t2", status: "ONLINE", clusterId: null, tags: [], canWrite: true },
      { id: "srv3", name: "Read-only", teamId: "t2", status: "ONLINE", clusterId: null, tags: [], canWrite: false },
    ] as never);
    vi.spyOn(api, "getMigrateCommand").mockResolvedValue({ opId: "op1", active: false, expiresAt: null, commandTemplate: "run on the source host" });
  });
  afterEach(() => vi.restoreAllMocks());

  /** The first step asks for the team and a target for each source server (nothing is chosen for the user): pick them. */
  const chooseTarget = async (host: string, team = "t1", server = "srv1") => {
    fireEvent.change(await screen.findByLabelText("Team"), { target: { value: team } });
    fireEvent.change(screen.getByLabelText(`${host} moves to`), { target: { value: server } });
  };

  const withMapping: ImportPlan = { ...plan, mapping: { features: ["mapping-v1"], stored: null, storedVersion: null, scopeKey: "team-3" } };

  it("sends the optional source team label on connect; a hub that offers mapping shows 'Review & rename' (no direct apply)", async () => {
    const connectSpy = vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(withMapping);
    const resolveSpy = vi.spyOn(api, "importResolve").mockResolvedValue({ version: 1, effective: [], projects: [], gitSources: [], conflicts: [], orphans: [], mappingHash: "m".repeat(32), counts: { renamed: 0, moved: 0, excluded: 0, aliased: 0, newProjects: 0, newEnvironments: 0 } });
    vi.spyOn(api, "importMappingGet").mockResolvedValue({ doc: null, version: null, label: null, lastAppliedAt: null });
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://coolify.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.change(screen.getByLabelText("Source team label"), { target: { value: "Team-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await chooseTarget("srv"); // the first step: What are you moving? (one source server: Everything)
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Import preview");
    expect(connectSpy).toHaveBeenCalledWith({ sourceKind: "coolify", teamId: "t1", baseUrl: "https://coolify.example.com", token: "tok", scopeLabel: "team-3" });
    expect(screen.queryByRole("button", { name: "Import to Tugra" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review & rename" }));
    await screen.findByText("Target team: Team One (derived from the server)");
    // every writable server on every team, grouped by team; the read-only one is not offered
    expect(screen.getByRole("option", { name: "Server B" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Read-only" })).toBeNull();
    await waitFor(() => expect(resolveSpy).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Back to preview" }));
    await screen.findByText("Import preview");
  });

  it("the plan step's env acks and Volume-copy data modes survive into the review step's resolve and apply; Continue stays disabled until the blocker is acknowledged", async () => {
    const ENV = "app:srv:envapp";
    const mappingBlock = { features: ["mapping-v1"], stored: null, storedVersion: null, scopeKey: "team-3" };
    const base: ImportPlan = {
      ...plan,
      totals: { apps: 1, databases: 1, volumes: 0, blockers: 1 },
      items: [
        { itemRef: ENV, kind: "app", name: "envapp", proposed: {}, risks: [{ level: "blocker", code: "app.env.unresolved", message: "1 variable cannot be read" }], dependsOn: [] },
        { itemRef: "database:srv:pg", kind: "database", name: "orders-db", proposed: { engine: "POSTGRES", version: "16", image: "postgres:16-alpine" }, risks: [], dependsOn: [] },
      ],
      mapping: mappingBlock,
    };
    const volPlan: ImportPlan = { ...base, planHash: "b".repeat(32), items: base.items.map((it) => (it.kind === "database" ? { ...it, proposed: { ...it.proposed, dataMode: "volume" } } : it)) };
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValueOnce(base).mockResolvedValue(volPlan);
    vi.spyOn(api, "importMappingGet").mockResolvedValue({ doc: null, version: null, label: null, lastAppliedAt: null });
    const eff = (itemRef: string, kind: "app" | "database", name: string) => ({ itemRef, kind, sourceName: name, include: true, name, project: null, environment: null, origin: { name: "source" as const, placement: "default" as const }, status: "pending" as const, changed: [] });
    const resolveSpy = vi.spyOn(api, "importResolve").mockResolvedValue({ version: 1, effective: [eff(ENV, "app", "envapp"), eff("database:srv:pg", "database", "orders-db")], projects: [], gitSources: [], conflicts: [], orphans: [], mappingHash: "m".repeat(32), counts: { renamed: 0, moved: 0, excluded: 0, aliased: 0, newProjects: 0, newEnvironments: 0 } });
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1", mappingApplied: true });
    vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await chooseTarget("srv");
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    const group = await screen.findByRole("radiogroup", { name: "Data mode: orders-db" });
    fireEvent.click(within(group).getByRole("radio", { name: "Volume copy" }));
    await screen.findByText(/Volume copy keeps the source image/);
    // the un-acked ackable blocker gates Continue (like the legacy Apply)
    const cont = screen.getByRole("button", { name: "Review & rename" }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Create envapp without these variables" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Review & rename" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Review & rename" }));
    const apply = await screen.findByRole("button", { name: /^Apply 1 apps/ });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    expect(resolveSpy).toHaveBeenLastCalledWith(expect.objectContaining({ planHash: "b".repeat(32), acks: [{ code: "app.env.unresolved", itemRef: ENV }], dbDataModes: { "database:srv:pg": "volume" } }));
    fireEvent.click(apply);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0][0]).toMatchObject({ planHash: "b".repeat(32), acks: [{ code: "app.env.unresolved", itemRef: ENV }], dbDataModes: { "database:srv:pg": "volume" }, mapping: expect.anything(), mappingHash: "m".repeat(32) });
  }, 15000);

  it("no Team picker on the connect screen; the first step picks a source server, the preview then shows only that server and the guided run steps aside", async () => {
    const multi: ImportPlan = {
      ...plan,
      totals: { apps: 2, databases: 0, volumes: 0, blockers: 0 },
      items: [
        { itemRef: "app:s1:web", kind: "app", name: "web-app", proposed: {}, risks: [], dependsOn: [] },
        { itemRef: "app:s2:api", kind: "app", name: "api-app", proposed: {}, risks: [], dependsOn: [] },
      ],
      preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "s1", name: "Box One" }, { ref: "s2", name: "Box Two" }] },
      mapping: { features: ["mapping-v1"], stored: null, storedVersion: null, scopeKey: "team-3" },
    };
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(multi);
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    expect(screen.queryByLabelText("Team")).toBeNull();
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByText("What are you moving?");
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Box Two/ }));
    await chooseTarget("Box Two");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Import preview");
    expect(screen.getByText("api-app")).toBeTruthy();
    expect(screen.queryByText("web-app")).toBeNull();
    expect(screen.getByRole("button", { name: "Run guided migration" })).toBeTruthy();
    // Change reopens the first step as it was left
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await screen.findByText("What are you moving?");
    expect((screen.getByRole("checkbox", { name: /Box Two/ }) as HTMLInputElement).checked).toBe(true);
  });

  describe("a refresh resumes the first step", () => {
    const multi: ImportPlan = {
      ...plan,
      items: [
        { itemRef: "app:s1:web", kind: "app", name: "web-app", proposed: {}, risks: [], dependsOn: [] },
        { itemRef: "app:s2:api", kind: "app", name: "api-app", proposed: {}, risks: [], dependsOn: [] },
      ],
      preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "s1", name: "Box One" }, { ref: "s2", name: "Box Two" }] },
      mapping: { features: ["mapping-v1"], stored: null, storedVersion: null, scopeKey: "team-3" },
    };
    const SID = "sess-0123456789";
    beforeEach(() => window.sessionStorage.clear());

    it("keeps the session and the picked servers in sessionStorage (never the token), and a reload reopens the first step as it was left", async () => {
      vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: SID, expiresAt: "2026-01-01T00:00:00.000Z" });
      const planSpy = vi.spyOn(api, "importPlan").mockResolvedValue(multi);
      const first = wrap(<ImportWizard />);
      await screen.findByLabelText("Coolify URL");
      await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
      fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
      fireEvent.change(screen.getByLabelText("API token"), { target: { value: "super-secret-token" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
      await screen.findByText("What are you moving?");
      fireEvent.click(screen.getByRole("checkbox", { name: /Box Two/ }));
      const stored = window.sessionStorage.getItem("tugra.import.resume")!;
      expect(stored).toContain(SID);
      expect(stored).not.toContain("super-secret-token");
      first.unmount();
      cleanup();
      qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      wrap(<ImportWizard />);
      await screen.findByText("What are you moving?");
      expect(planSpy).toHaveBeenLastCalledWith({ sourceKind: "coolify", sessionId: SID });
      expect((screen.getByRole("checkbox", { name: /Box Two/ }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole("checkbox", { name: /Box One/ }) as HTMLInputElement).checked).toBe(false);
    });

    it("an ended hub session falls back to the connect form with the address kept and says why", async () => {
      window.sessionStorage.setItem("tugra.import.resume", JSON.stringify({ v: 1, kind: "coolify", baseUrl: "https://c.example.com", sessionId: SID, dbModes: {} }));
      vi.spyOn(api, "importPlan").mockRejectedValue(new ApiError(400, "import session expired or revoked — reconnect"));
      wrap(<ImportWizard />);
      await screen.findByText(/Your earlier import session ended/);
      expect((screen.getByLabelText("Coolify URL") as HTMLInputElement).value).toBe("https://c.example.com");
      expect((screen.getByLabelText("API token") as HTMLInputElement).value).toBe("");
      expect(window.sessionStorage.getItem("tugra.import.resume")).toBeNull();
    });

    it("starting an apply drops the resume record, so a later visit does not reopen the spent picks", async () => {
      window.sessionStorage.setItem("tugra.import.resume", JSON.stringify({ v: 1, kind: "coolify", baseUrl: "https://c.example.com", sessionId: SID, dbModes: {} }));
      vi.spyOn(api, "importPlan").mockResolvedValue(plan); // legacy one-click plan
      vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
      vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
      wrap(<ImportWizard />);
      await screen.findByRole("option", { name: "Server A" });
      expect(window.sessionStorage.getItem("tugra.import.resume")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
      await screen.findByText("DONE");
      expect(window.sessionStorage.getItem("tugra.import.resume")).toBeNull();
    });

    it("opening a running op through ?op= drops a stale resume record", async () => {
      window.sessionStorage.setItem("tugra.import.resume", JSON.stringify({ v: 1, kind: "coolify", baseUrl: "https://c.example.com", sessionId: SID, dbModes: {} }));
      window.history.replaceState(null, "", "/import?op=op1");
      vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
      wrap(<ImportWizard />);
      await screen.findByText("DONE");
      expect(window.sessionStorage.getItem("tugra.import.resume")).toBeNull();
    });

    it("Start over ends the hub session and forgets the resume state", async () => {
      window.sessionStorage.setItem("tugra.import.resume", JSON.stringify({ v: 1, kind: "coolify", baseUrl: "https://c.example.com", sessionId: SID, dbModes: {} }));
      vi.spyOn(api, "importPlan").mockResolvedValue(multi);
      const revoke = vi.spyOn(api, "importRevoke").mockResolvedValue({ ok: true });
      wrap(<ImportWizard />);
      await screen.findByText("What are you moving?");
      fireEvent.click(screen.getByRole("button", { name: "Start over" }));
      expect(revoke).toHaveBeenCalledWith(SID);
      await screen.findByLabelText("Coolify URL");
      expect(window.sessionStorage.getItem("tugra.import.resume")).toBeNull();
    });
  });

  it("an older hub (no mapping feature flag) keeps the legacy one-click apply and never sends mapping fields", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan); // no `mapping` block
    const applySpy = vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue(settledOp);
    const resolveSpy = vi.spyOn(api, "importResolve");
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
    expect(screen.queryByRole("button", { name: "Review & rename" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("DONE");
    expect(applySpy).toHaveBeenCalledWith({ sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", planHash: "a".repeat(32) });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("the timeline shows the source name next to a mapped, renamed task", async () => {
    vi.spyOn(api, "importConnect").mockResolvedValue({ sessionId: "s1", expiresAt: "2026-01-01T00:00:00.000Z" });
    vi.spyOn(api, "importPlan").mockResolvedValue(plan);
    vi.spyOn(api, "importApply").mockResolvedValue({ opId: "op1" });
    vi.spyOn(api, "getImportOperation").mockResolvedValue({ ...settledOp, tasks: [{ ...settledOp.tasks[0], name: "Storefront", sourceName: "web-app", mapped: true }] });
    wrap(<ImportWizard />);
    await screen.findByLabelText("Coolify URL");
    await waitFor(() => expect(qc.getQueryData(["teams"])).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Coolify URL"), { target: { value: "https://c.example.com" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & preview" }));
    await screen.findByRole("option", { name: "Server A" });
    fireEvent.click(screen.getByRole("button", { name: "Import to Tugra" }));
    await screen.findByText("DONE");
    expect(screen.getByText("Storefront")).toBeTruthy();
    expect(screen.getByText("was: web-app")).toBeTruthy();
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
