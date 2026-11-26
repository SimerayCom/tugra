import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { ConfirmProvider } from "../confirm";
import { api } from "../../lib/api";
import { DryRunDecision } from "./dry-run-decision";
import { mkRun, mkStep } from "./test-fixtures";
import type { MigrationRunView } from "../../lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

const hints = { imagePins: [], workerMarks: [], warningAcks: [], servicePins: [], warningsFixed: [] };
const run = (over: Partial<MigrationRunView> = {}): MigrationRunView =>
  mkRun(
    { dryRun: true, status: "DRY_RUN_DONE", currentStep: null, targetServerId: "srv1", targetServers: [{ serverId: "srv1", serverName: "Box A", primary: true }], allowed: { ...mkRun().allowed, start: true, pause: false, abort: false }, ...over },
    [mkStep("IMPORT", "PASSED", { progress: { done: 0, total: 1, unit: "item", dryRun: [{ code: "import.projection", level: "info", params: { apps: 1, databases: 0, services: 0 } }] } })],
  );
const server = (over: Record<string, unknown> = {}) => ({ id: "srv1", name: "Box A", teamId: "t1", status: "ONLINE", capabilities: ["deploy"], ...over });
const mount = (r: MigrationRunView) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <DryRunDecision run={r} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
const startBtn = () => screen.getByRole("button", { name: "Start migration" }) as HTMLButtonElement;
const active = { state: "active" as const, expiresAt: "2099-01-01T00:00:00Z", viaAgent: false, agentServerId: null, sourceTeamRef: null };

describe("the start of a finished dry run says what would stop it before the click", () => {
  beforeEach(() => {
    vi.spyOn(api, "getMigrationRunSafetyHints").mockResolvedValue(hints);
  });

  it("a ready target and a live session leave Start open and say nothing", async () => {
    vi.spyOn(api, "listServers").mockResolvedValue([server()] as never);
    mount(run({ sourceSession: active }));
    await screen.findByText("No problems found. You can start the real migration.");
    await waitFor(() => expect(api.listServers).toHaveBeenCalled());
    expect(screen.queryByTestId("promote-guard")).toBeNull();
    expect(startBtn().disabled).toBe(false);
  });

  it("a target that went offline keeps Start off, names the server and links to it", async () => {
    vi.spyOn(api, "listServers").mockResolvedValue([server({ status: "OFFLINE" })] as never);
    mount(run({ sourceSession: active }));
    const block = await screen.findByTestId("promote-target-block");
    expect(block.textContent).toContain("Box A is offline");
    expect(within(block).getByRole("link", { name: "Open the server" }).getAttribute("href")).toBe("/servers/srv1");
    expect(startBtn().disabled).toBe(true);
  });

  it("a target without the deploy grant links to the capability switches", async () => {
    vi.spyOn(api, "listServers").mockResolvedValue([server({ capabilities: [] })] as never);
    mount(run({ sourceSession: active }));
    const block = await screen.findByTestId("promote-target-block");
    expect(block.textContent).toContain("Deploy apps permission");
    expect(within(block).getByRole("link", { name: "Open the server" }).getAttribute("href")).toContain("tab=maintenance");
  });

  it("an ended Coolify read is read again through the same agent and team, and Start opens with the new session", async () => {
    vi.spyOn(api, "listServers").mockResolvedValue([server(), server({ id: "host1", name: "Coolify host", teamId: "t9" })] as never);
    const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValue({ sessionId: "s-new", expiresAt: "2099-01-01T00:00:00Z", read: {}, teams: [{ ref: "a", name: "A" }, { ref: "b", name: "B" }] } as never);
    mount(run({ sourceSession: { state: "expired", expiresAt: null, viaAgent: true, agentServerId: "host1", sourceTeamRef: "b" } }));
    const panel = await screen.findByTestId("promote-session-agent");
    expect(startBtn().disabled).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Read Coolify again" }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith({ teamId: "t9", serverId: "host1", sourceTeamRef: "b" }));
    await waitFor(() => expect(screen.queryByTestId("promote-guard")).toBeNull());
    expect(startBtn().disabled).toBe(false);
  });

  it("a Coolify with several teams and no remembered one asks which, once", async () => {
    vi.spyOn(api, "listServers").mockResolvedValue([server(), server({ id: "host1", name: "Coolify host", teamId: "t9" })] as never);
    const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValue({ sessionId: "s-new", expiresAt: "2099-01-01T00:00:00Z", read: {}, teams: [{ ref: "a", name: "A" }, { ref: "b", name: "B" }] } as never);
    vi.spyOn(api, "importRevoke").mockResolvedValue(undefined as never);
    mount(run({ sourceSession: { state: "missing", expiresAt: null, viaAgent: true, agentServerId: "host1", sourceTeamRef: null } }));
    const panel = await screen.findByTestId("promote-session-agent");
    fireEvent.click(within(panel).getByRole("button", { name: "Read Coolify again" }));
    const pick = await screen.findByTestId("promote-team");
    expect((within(pick).getByRole("button", { name: "Continue with this team" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(pick).getByRole("combobox"), { target: { value: "b" } });
    fireEvent.click(within(pick).getByRole("button", { name: "Continue with this team" }));
    await waitFor(() => expect(connect).toHaveBeenLastCalledWith({ teamId: "t9", serverId: "host1", sourceTeamRef: "b" }));
    await waitFor(() => expect(screen.queryByTestId("promote-guard")).toBeNull());
  });

  it("a Coolify host that is no longer one of the servers is said plainly", async () => {
    vi.spyOn(api, "listServers").mockResolvedValue([server()] as never);
    mount(run({ sourceSession: { state: "expired", expiresAt: null, viaAgent: true, agentServerId: "gone", sourceTeamRef: null } }));
    expect((await screen.findByTestId("promote-host-missing")).textContent).toContain("no longer in your servers");
    expect(startBtn().disabled).toBe(true);
  });

  it("an ended token session shows the token form instead", async () => {
    vi.spyOn(api, "listServers").mockResolvedValue([server()] as never);
    mount(run({ sourceSession: { state: "expired", expiresAt: null, viaAgent: false, agentServerId: null, sourceTeamRef: null } }));
    const panel = await screen.findByTestId("promote-session-token");
    expect(within(panel).getByLabelText("Source API token")).toBeTruthy();
    expect(startBtn().disabled).toBe(true);
  });
});
