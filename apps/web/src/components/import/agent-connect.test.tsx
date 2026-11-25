import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { api, ApiError } from "../../lib/api";
import { ToastProvider } from "../toast";
import type { ImportAgentSession } from "../../lib/types";
import { AgentConnectPanel } from "./agent-connect";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const SERVERS = [
  { id: "s1", name: "coolify-host", teamId: "t1", status: "ONLINE", canWrite: true },
  { id: "s2", name: "build-box", teamId: "t2", status: "OFFLINE", canWrite: true },
  { id: "s3", name: "read-only", teamId: "t1", status: "ONLINE", canWrite: false },
] as never[];

const SESSION: ImportAgentSession = {
  sessionId: "sess-1",
  expiresAt: "2026-11-26T12:00:00Z",
  read: { transport: "agent", agentServerId: "s1", schemaVersion: "2026_01_01_a", coolifyImage: "ghcr.io/coollabsio/coolify:4.7.8", readAt: "2026-11-26T11:00:00Z", counts: { teams: 3, projects: 9, servers: 27, applications: 78, databases: 29, services: 19 }, secretCounts: { env: 1240, db_credentials: 29 } },
} as ImportAgentSession;

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "coolifyDetect").mockResolvedValue({ found: true, image: "ghcr.io/coollabsio/coolify:4.7.8" });
});
function mount(props: Partial<React.ComponentProps<typeof AgentConnectPanel>> = {}) {
  const onConnected = vi.fn();
  const ui = (p: Partial<React.ComponentProps<typeof AgentConnectPanel>>) => (
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <AgentConnectPanel servers={SERVERS} onConnected={onConnected} {...p} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
  const r = render(ui(props));
  return { onConnected, setBusy: (busy: boolean) => r.rerender(ui({ ...props, busy })) };
}
const pick = (id: string) => fireEvent.change(screen.getByLabelText("Tugra server where Coolify runs"), { target: { value: id } });

describe("AgentConnectPanel", () => {
  it("offers the servers the user can write to, from any team; an offline one is listed but cannot be picked", () => {
    mount();
    const opts = [...(screen.getByLabelText("Tugra server where Coolify runs") as HTMLSelectElement).options].filter((o) => o.value);
    expect(opts.map((o) => [o.textContent, o.disabled])).toEqual([["coolify-host", false], ["build-box (agent offline)", true]]);
    expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(true); // nothing picked yet
    expect(screen.getByText("Nothing is changed or stopped.")).toBeTruthy();
  });

  it("says so when no server has an agent yet", () => {
    mount({ servers: [] });
    expect(screen.getByText(/None of your servers has a connected Tugra agent yet/)).toBeTruthy();
    expect(screen.queryByLabelText("Tugra server where Coolify runs")).toBeNull();
  });

  it("reads Coolify through the agent of the picked server, in that server's team, with no token and no address", async () => {
    const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValue(SESSION);
    mount();
    pick("s1");
    fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
    await screen.findByText("Found in Coolify");
    expect(connect).toHaveBeenCalledWith({ teamId: "t1", serverId: "s1" });
    expect(screen.getByText("78")).toBeTruthy(); // applications
    expect(screen.getByText("Coolify version 4.7.8")).toBeTruthy();
    expect(screen.getByText(/Secret values found, not read yet: 1269/)).toBeTruthy();
  });

  it("asks before it reads when the server has not been allowed yet, then allows and reads in one go", async () => {
    const connect = vi.spyOn(api, "importConnectAgent").mockRejectedValueOnce(new ApiError(403, "not opted in", "not_enabled")).mockResolvedValueOnce(SESSION);
    const enable = vi.spyOn(api, "coolifyEnable").mockResolvedValue({} as never);
    mount();
    pick("s1");
    fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
    await screen.findByText("Allow reading this Coolify");
    expect(enable).not.toHaveBeenCalled(); // asking is not allowing
    expect(screen.getByText(/Nothing is changed or stopped, and no secret value is read yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow and read Coolify" }));
    await screen.findByText("Found in Coolify");
    expect(enable).toHaveBeenCalledWith("s1");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("warns, before the read, when no Coolify is found on the picked server", async () => {
    vi.spyOn(api, "coolifyDetect").mockResolvedValue({ found: false, image: null, reason: "db_stopped" });
    mount();
    pick("s1");
    await screen.findByText("Coolify's database is not running on this server.");
  });

  it("explains a failed read in the user's words", async () => {
    vi.spyOn(api, "importConnectAgent").mockRejectedValue(new ApiError(409, "x", "agent_offline"));
    mount();
    pick("s1");
    fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
    await screen.findByText(/agent is offline/);
    expect(screen.queryByText("Found in Coolify")).toBeNull();
  });

  it("after the read it asks for the consent of THIS session and then continues with the server and the session", async () => {
    vi.spyOn(api, "importConnectAgent").mockResolvedValue(SESSION);
    const grant = vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue({ id: "g1", kind: "secrets", serverId: "s1", classes: ["env"], status: "active", grantedById: "u", expiresAt: "2026-11-27T10:00:00Z", revokedAt: null, createdAt: "2026-11-26T10:00:00Z" } as never);
    const { onConnected } = mount();
    pick("s1");
    fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
    await screen.findByText("Allow reading secret values");
    expect(screen.getByText("1240 found")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Type the Coolify server name to allow it"), { target: { value: "coolify-host" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(grant).toHaveBeenCalledWith(expect.objectContaining({ serverId: "s1", importSessionId: "sess-1", confirm: "coolify-host" })));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConnected).toHaveBeenCalledWith(SESSION, { id: "s1", name: "coolify-host", teamId: "t1" });
  });

  it("continuing does not need the consent (the match step asks again), and is held while the plan is being read", async () => {
    vi.spyOn(api, "importConnectAgent").mockResolvedValue(SESSION);
    const { onConnected, setBusy } = mount();
    pick("s1");
    fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
    await screen.findByText("Found in Coolify");
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    setBusy(true);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConnected).not.toHaveBeenCalled();
  });
});
