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
  { id: "s1", name: "coolify-host", teamId: "t1", status: "ONLINE", canWrite: true, capabilities: ["database", "deploy"] },
  { id: "s2", name: "build-box", teamId: "t2", status: "OFFLINE", canWrite: true, capabilities: ["database"] },
  { id: "s3", name: "read-only", teamId: "t1", status: "ONLINE", canWrite: false, capabilities: ["database"] },
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

  it("a server whose agent has no database capability is tagged and cannot be picked, with the way to turn it on", () => {
    const servers = [...SERVERS, { id: "s4", name: "no-db", teamId: "t1", status: "ONLINE", canWrite: true, capabilities: ["deploy"] }] as never[];
    mount({ servers });
    const opts = [...(screen.getByLabelText("Tugra server where Coolify runs") as HTMLSelectElement).options].filter((o) => o.value);
    expect(opts.find((o) => o.value === "s4")).toMatchObject({ disabled: true });
    expect(opts.find((o) => o.value === "s4")!.textContent).toContain("capability off");
    expect(screen.getByRole("link", { name: "Turn it on" }).getAttribute("href")).toBe("/servers/s4?tab=maintenance");
  });

  it("a failed check says why and offers Check again (it is no longer a button that stays off in silence)", async () => {
    const detect = vi.spyOn(api, "coolifyDetect").mockRejectedValueOnce(new ApiError(403, 'capability "database" is not granted for this server'));
    mount();
    pick("s1");
    const note = await screen.findByTestId("detect-failed");
    expect(note.textContent).toContain("has not been given the database capability");
    expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(true);
    detect.mockResolvedValue({ found: true, image: "ghcr.io/coollabsio/coolify:4.7.8" });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("detect-failed")).toBeNull();
  });

  it("an offline agent or a throttled check each get their own line", async () => {
    vi.spyOn(api, "coolifyDetect").mockRejectedValueOnce(new ApiError(503, "agent offline"));
    mount();
    pick("s1");
    expect((await screen.findByTestId("detect-failed")).textContent).toContain("The agent is offline");
    cleanup();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "coolifyDetect").mockRejectedValueOnce(new ApiError(429, "Too Many Requests"));
    mount();
    pick("s1");
    expect((await screen.findByTestId("detect-failed")).textContent).toContain("Try again in a minute");
  });

  it("the read's own reason reaches the screen: agent offline, not read-only, unreadable", async () => {
    for (const [code, text] of [["agent_offline", "The agent is offline"], ["not_read_only", "safe, read-only way"], ["unreadable", "could not be read completely"]] as const) {
      cleanup();
      qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.spyOn(api, "importConnectAgent").mockRejectedValueOnce(new ApiError(400, "x", code));
      const toasts: string[] = [];
      const { subscribeToast } = await import("../../lib/toast-bus");
      const off = subscribeToast((m) => toasts.push(m.message));
      mount();
      pick("s1");
      await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
      await waitFor(() => expect(toasts.some((m) => m.includes(text))).toBe(true));
      off();
    }
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
    await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
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
    await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
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
    expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(true); // nothing is opted in or read there
  });

  it("explains a failed read in the user's words", async () => {
    vi.spyOn(api, "importConnectAgent").mockRejectedValue(new ApiError(409, "x", "agent_offline"));
    mount();
    pick("s1");
    await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
    await screen.findByText(/agent is offline/);
    expect(screen.queryByText("Found in Coolify")).toBeNull();
  });

  it("after the read it asks for the consent of THIS session and then continues with the server and the session", async () => {
    vi.spyOn(api, "importConnectAgent").mockResolvedValue(SESSION);
    const grant = vi.spyOn(api, "coolifySecretsGrant").mockResolvedValue({ id: "g1", kind: "secrets", serverId: "s1", classes: ["env"], status: "active", grantedById: "u", expiresAt: "2026-11-27T10:00:00Z", revokedAt: null, createdAt: "2026-11-26T10:00:00Z" } as never);
    const { onConnected } = mount();
    pick("s1");
    await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
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
    await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
    await screen.findByText("Found in Coolify");
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    setBusy(true);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConnected).not.toHaveBeenCalled();
  });

  describe("a Coolify with several teams", () => {
    const MULTI: ImportAgentSession = { ...SESSION, teams: [{ ref: "1", name: "Alpha" }, { ref: "2", name: "Beta" }] };
    const PICKED: ImportAgentSession = { ...MULTI, sessionId: "sess-2" };
    const read = async () => {
      pick("s1");
      await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
      await screen.findByText("Found in Coolify");
    };

    it("asks which team and picks none for the owner: Continue and the consent wait for the choice", async () => {
      vi.spyOn(api, "importConnectAgent").mockResolvedValue(MULTI);
      const { onConnected } = mount();
      await read();
      const select = screen.getByLabelText("Coolify team") as HTMLSelectElement;
      expect(select.value).toBe("");
      expect([...select.options].filter((o) => o.value).map((o) => o.textContent)).toEqual(["Alpha", "Beta"]);
      expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText("Pick a Coolify team to continue.")).toBeTruthy();
      expect(screen.queryByText("Allow reading secret values")).toBeNull(); // the consent belongs to the session that carries the team
      expect(onConnected).not.toHaveBeenCalled();
    });

    it("the choice reads again with that team (sourceTeamRef), ends the first session, and continues with the new one", async () => {
      const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValueOnce(MULTI).mockResolvedValueOnce(PICKED);
      const revoke = vi.spyOn(api, "importRevoke").mockResolvedValue({ ok: true });
      const { onConnected } = mount();
      await read();
      fireEvent.change(screen.getByLabelText("Coolify team"), { target: { value: "2" } });
      await waitFor(() => expect(connect).toHaveBeenLastCalledWith({ teamId: "t1", serverId: "s1", sourceTeamRef: "2" }));
      await waitFor(() => expect(revoke).toHaveBeenCalledWith("sess-1"));
      await screen.findByText("Allow reading secret values");
      await waitFor(() => expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(onConnected).toHaveBeenCalledWith(PICKED, { id: "s1", name: "coolify-host", teamId: "t1" });
    });

    it("while the picked team is read, the picker keeps the choice and says what is happening", async () => {
      let finish: (s: ImportAgentSession) => void = () => undefined;
      vi.spyOn(api, "importConnectAgent").mockResolvedValueOnce(MULTI).mockImplementationOnce(() => new Promise((r) => { finish = r; }));
      vi.spyOn(api, "importRevoke").mockResolvedValue({ ok: true });
      mount();
      await read();
      fireEvent.change(screen.getByLabelText("Coolify team"), { target: { value: "2" } });
      await screen.findByText("Reading Beta from Coolify. This takes a few seconds…");
      expect((screen.getByLabelText("Coolify team") as HTMLSelectElement).value).toBe("2");
      expect(screen.getByRole("button", { name: "Continue" }).getAttribute("aria-busy")).toBe("true");
      finish(PICKED);
      await waitFor(() => expect(screen.queryByText("Reading Beta from Coolify. This takes a few seconds…")).toBeNull());
    });

    it("a failed re-read keeps the owner on the choice with the reason; one team or none shows no picker", async () => {
      vi.spyOn(api, "importConnectAgent").mockResolvedValueOnce(MULTI).mockRejectedValueOnce(new ApiError(400, "x", "unknown_team"));
      mount();
      await read();
      fireEvent.change(screen.getByLabelText("Coolify team"), { target: { value: "1" } });
      await screen.findByText("That Coolify team has no projects.");
      expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
      cleanup();
      vi.restoreAllMocks();
      vi.spyOn(api, "coolifyDetect").mockResolvedValue({ found: true, image: null });
      vi.spyOn(api, "importConnectAgent").mockResolvedValue({ ...SESSION, teams: [{ ref: "1", name: "Alpha" }] });
      mount();
      await read();
      expect(screen.queryByLabelText("Coolify team")).toBeNull();
      expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe("an owner is needed for the move, said before anything is read", () => {
    it("an admin of the team gets the reason as soon as the server is picked and cannot start the read", async () => {
      vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "ADMIN" }] as never);
      const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValue(SESSION);
      mount();
      pick("s1");
      await screen.findByTestId("agent-owner-needed");
      expect(screen.getByTestId("agent-owner-needed").textContent).toMatch(/An owner of Acme has to run this move/);
      await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(true));
      expect(connect).not.toHaveBeenCalled();
    });

    it("an owner sees no such note", async () => {
      vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "Acme", role: "OWNER" }] as never);
      mount();
      pick("s1");
      await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
      expect(screen.queryByTestId("agent-owner-needed")).toBeNull();
    });
  });

  describe("a session that was read here and never handed on is ended with its consent", () => {
    const readIt = async () => {
      pick("s1");
      await waitFor(() => expect((screen.getByRole("button", { name: "Read Coolify" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "Read Coolify" }));
      await screen.findByText("Found in Coolify");
    };

    it("leaving the panel (another source, the token path, or the page) before Continue revokes the session", async () => {
      vi.spyOn(api, "importConnectAgent").mockResolvedValue(SESSION);
      const revoke = vi.spyOn(api, "importRevoke").mockResolvedValue({ ok: true });
      mount();
      await readIt();
      expect(revoke).not.toHaveBeenCalled();
      cleanup(); // the wizard unmounts the panel when the owner switches the source or the way to connect
      expect(revoke).toHaveBeenCalledWith("sess-1");
      expect(revoke).toHaveBeenCalledTimes(1);
    });

    it("after Continue the wizard owns the session: leaving the panel then revokes nothing", async () => {
      vi.spyOn(api, "importConnectAgent").mockResolvedValue(SESSION);
      const revoke = vi.spyOn(api, "importRevoke").mockResolvedValue({ ok: true });
      mount();
      await readIt();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      cleanup();
      expect(revoke).not.toHaveBeenCalled();
    });

    it("a panel that never read anything has nothing to revoke", () => {
      const revoke = vi.spyOn(api, "importRevoke").mockResolvedValue({ ok: true });
      mount();
      cleanup();
      expect(revoke).not.toHaveBeenCalled();
    });
  });
});
