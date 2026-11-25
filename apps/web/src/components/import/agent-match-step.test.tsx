import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api, ApiError } from "../../lib/api";
import { ToastProvider } from "../toast";
import type { ImportPlan } from "../../lib/types";
import { AgentMatchStep } from "./agent-match-step";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const READ = { transport: "agent", agentServerId: "s0", schemaVersion: null, coolifyImage: null, readAt: "2026-11-26T00:00:00Z", counts: { teams: 1, projects: 1, servers: 4, applications: 3, databases: 1, services: 0 }, secretCounts: { env: 12 } };
const HOSTS = [
  { ref: "local", name: "localhost", controlPlane: true, tugra: { serverId: "s0", name: "hub-box", teamId: "t1", via: "public-ip", confidence: "certain" }, match: { status: "certain", linkedBy: "auto", evidence: [{ kind: "machine_id", equal: true }] }, agentOnline: true },
  { ref: "edge", name: "edge", tugra: { serverId: "t-edge", name: "edge-1", teamId: "t1", via: "public-ip", confidence: "certain" }, match: { status: "certain", linkedBy: "auto", evidence: [{ kind: "ssh_host_key", equal: true }, { kind: "ip", equal: true }] }, agentOnline: true },
  { ref: "maybe", name: "maybe", tugra: { serverId: "t-maybe", name: "maybe-1", teamId: "t1", via: "reported-ip", confidence: "probable" }, match: { status: "probable", linkedBy: "auto", evidence: [{ kind: "ip", equal: true }] }, agentOnline: false },
  { ref: "unsure", name: "unsure", match: { status: "ambiguous", linkedBy: null, evidence: [{ kind: "hostname", equal: true }] } },
  { ref: "clash", name: "clash", match: { status: "ambiguous", linkedBy: null, evidence: [{ kind: "ip", equal: true }, { kind: "machine_id", equal: false }] } },
  { ref: "mine", name: "mine", tugra: { serverId: "t-mine", name: "mine-1", teamId: "t1", via: "owner", confidence: "probable" }, match: { status: "probable", linkedBy: "user", evidence: [] }, agentOnline: true },
];
const plan = (extra: Record<string, unknown> = {}): ImportPlan =>
  ({ sourceKind: "coolify", mode: "copy", items: [], totals: { apps: 0, databases: 0, volumes: 0, blockers: 0 }, warnings: [], planHash: "a".repeat(32), preflight: { databases: [], hosts: HOSTS, agentRead: READ, ...extra } }) as unknown as ImportPlan;
const SERVERS = [
  { id: "s0", name: "hub-box", teamId: "t1", status: "ONLINE", canWrite: true },
  { id: "t-edge", name: "edge-1", teamId: "t1", status: "ONLINE", canWrite: true },
  { id: "t-maybe", name: "maybe-1", teamId: "t1", status: "OFFLINE", canWrite: true },
  { id: "t-other", name: "other-box", teamId: "t1", status: "ONLINE", canWrite: true },
  { id: "t-ro", name: "read-only-box", teamId: "t1", status: "ONLINE", canWrite: false },
] as never[];

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
function mount(over: Partial<React.ComponentProps<typeof AgentMatchStep>> = {}) {
  const fns = { onContinue: vi.fn(), onRecheck: vi.fn(), onStartOver: vi.fn() };
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <AgentMatchStep plan={plan()} sessionId="sess-1" servers={SERVERS} teamId="t1" coolifyServer={{ id: "s0", name: "hub-box" }} {...fns} {...over} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return fns;
}
const card = (ref: string) => screen.getByTestId(`match-${ref}`);

describe("AgentMatchStep", () => {
  it("lists every Coolify server with how sure the hub is, and says how many still need a look", () => {
    mount();
    expect(within(card("edge")).getByText("Same machine")).toBeTruthy();
    expect(within(card("maybe")).getByText("Probably the same")).toBeTruthy();
    expect(within(card("unsure")).getByText("Not sure")).toBeTruthy();
    expect(within(card("local")).getByText("Coolify host (this server)")).toBeTruthy();
    expect(screen.getByText("3 to check")).toBeTruthy(); // maybe, unsure and clash; the host, the sure one and the owner's own answer do not count
  });

  it("shows the evidence plainly: what proves it, what only suggests it, what never decides, and what differs", () => {
    mount();
    const edge = card("edge");
    expect(within(edge).getByText("Same SSH host key")).toBeTruthy();
    expect(within(edge).getByText("(Proves it)")).toBeTruthy();
    expect(within(edge).getByText("Same address")).toBeTruthy();
    expect(within(edge).getByText("(Suggests it)")).toBeTruthy();
    expect(within(card("unsure")).getByText("Same host name")).toBeTruthy();
    expect(within(card("unsure")).getByText("(Never decides)")).toBeTruthy();
    expect(within(card("clash")).getByText("Different machine id")).toBeTruthy();
    expect(within(card("local")).queryByText("Proves it")).toBeNull();
  });

  it("names the matched Tugra server and whether its agent is online, and shows no address anywhere", () => {
    mount();
    expect(within(card("edge")).getByText(/Same machine as edge-1/)).toBeTruthy();
    expect(within(card("edge")).getByText(/Tugra agent: online/)).toBeTruthy();
    expect(within(card("maybe")).getByText(/Tugra agent: offline/)).toBeTruthy();
    expect(within(card("unsure")).getByText("No Tugra server matches yet")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it("the Coolify host itself cannot be answered for: it is always this server", () => {
    mount();
    expect(within(card("local")).queryByRole("button")).toBeNull();
    expect(within(card("local")).getByText(/always the same machine/)).toBeTruthy();
  });

  it("the owner names the Tugra server for a server the hub is unsure of (servers they cannot write to are not offered), then the plan is read again", async () => {
    const link = vi.spyOn(api, "importHostLink").mockResolvedValue({ hostLinks: {} });
    const { onRecheck } = mount();
    const unsure = card("unsure");
    const select = within(unsure).getByLabelText("Which Tugra server is it?") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).not.toContain("read-only-box");
    expect([...select.options].map((o) => o.textContent)).toContain("other-box");
    fireEvent.change(select, { target: { value: "t-other" } });
    fireEvent.click(within(unsure).getByRole("button", { name: "This is the same server" }));
    await waitFor(() => expect(link).toHaveBeenCalledWith("sess-1", { coolifyServerUuid: "unsure", serverId: "t-other" }));
    await waitFor(() => expect(onRecheck).toHaveBeenCalled());
  });

  it("'this is the same server' stays shut until a server is picked, and the current match is preselected", () => {
    mount();
    expect((within(card("unsure")).getByRole("button", { name: "This is the same server" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card("maybe")).getByLabelText("Which Tugra server is it?") as HTMLSelectElement).value).toBe("t-maybe");
  });

  it("'this is not the same server' sends null, and taking an answer back sends a reset (only shown for the owner's own answer)", async () => {
    const link = vi.spyOn(api, "importHostLink").mockResolvedValue({ hostLinks: {} });
    mount();
    fireEvent.click(within(card("maybe")).getByRole("button", { name: "This is not the same server" }));
    await waitFor(() => expect(link).toHaveBeenCalledWith("sess-1", { coolifyServerUuid: "maybe", serverId: null }));
    expect(within(card("maybe")).queryByRole("button", { name: "Take my answer back" })).toBeNull();
    fireEvent.click(within(card("mine")).getByRole("button", { name: "Take my answer back" }));
    await waitFor(() => expect(link).toHaveBeenCalledWith("sess-1", { coolifyServerUuid: "mine", serverId: null, reset: true }));
    expect(within(card("mine")).getByText("Chosen by you")).toBeTruthy();
  });

  it("a server whose machine identity differs cannot be called the same machine from here", () => {
    mount();
    const clash = card("clash");
    expect(within(clash).getByText(/machine identity of the two servers differs/)).toBeTruthy();
    expect((within(clash).getByRole("button", { name: "This is the same server" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(clash).getByRole("button", { name: "This is not the same server" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains a refusal from the hub (identity conflict) instead of failing silently", async () => {
    vi.spyOn(api, "importHostLink").mockRejectedValue(new ApiError(409, "x", "identity_conflict"));
    const { onRecheck } = mount();
    const select = within(card("unsure")).getByLabelText("Which Tugra server is it?");
    fireEvent.change(select, { target: { value: "t-other" } });
    fireEvent.click(within(card("unsure")).getByRole("button", { name: "This is the same server" }));
    await screen.findAllByText(/machine identity of the two servers differs/);
    expect(onRecheck).not.toHaveBeenCalled();
  });

  it("asks for the secret-value consent here when none stands, and not when the plan says one does", () => {
    mount();
    expect(screen.getByText("Allow reading secret values")).toBeTruthy();
    cleanup();
    vi.spyOn(api, "coolifySecretsGrants").mockResolvedValue([]);
    mount({ plan: plan({ secretsConsent: { classes: ["env"] } }) });
    expect(screen.getByText("Secret values are allowed for this import")).toBeTruthy();
    expect(screen.queryByLabelText("Type the Coolify server name to allow it")).toBeNull();
  });

  it("'Not now' leaves a plain reminder instead of hiding the consent for good", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByText(/Apps and databases cannot be imported until you allow them/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow now" }));
    expect(screen.getByText("Allow reading secret values")).toBeTruthy();
  });

  it("continues, with the number still to check on the button, and can start over", () => {
    const { onContinue, onStartOver } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Continue with 3 to check" }));
    expect(onContinue).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(onStartOver).toHaveBeenCalled();
  });

  it("says every server is matched when nothing is left, and links to the one-click agent install", () => {
    mount({ plan: plan({ hosts: [HOSTS[0], HOSTS[1]] }) });
    expect(screen.getByText("Every server is matched.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Read this Coolify" }).getAttribute("href")).toBe("/import/coolify-host");
  });

  it("does not ask for consent when the Coolify host is not one of the user's servers (nothing to type a name of)", () => {
    mount({ coolifyServer: null });
    expect(screen.queryByText("Allow reading secret values")).toBeNull();
  });
});
