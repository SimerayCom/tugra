import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import { CoolifyTakeOverButton } from "./coolify-take-over-button";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

afterEach(cleanup);
beforeEach(() => {
  vi.restoreAllMocks();
  nav.push.mockClear();
  window.sessionStorage.clear();
  vi.spyOn(api, "listMigrationRuns").mockResolvedValue([]);
});

const show = (props: Partial<React.ComponentProps<typeof CoolifyTakeOverButton>> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <CoolifyTakeOverButton row={{ serverId: "s1", name: "box", takeover: "none" }} teamId="t1" hubServerId="hub" {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
const focus = () => JSON.parse(window.sessionStorage.getItem("tugra.import.focus") ?? "null");

describe("CoolifyTakeOverButton", () => {
  it("makes the agent-path session on the Coolify host and opens the import with that session and server, nothing defaulted", async () => {
    const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValue({ sessionId: "sess-1234abcd", expiresAt: "x", read: {} } as never);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Take over in place" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/import"));
    expect(connect).toHaveBeenCalledWith({ teamId: "t1", serverId: "hub" }); // no sourceTeamRef: the owner never chose one
    expect(focus()).toEqual({ kind: "coolify", agentSessionId: "sess-1234abcd", inPlaceServerId: "s1", fromServerName: "box" });
  });

  it("the session is made in the Coolify host's own team when the server being taken over is in another team", async () => {
    const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValue({ sessionId: "sess-5678abcd", expiresAt: "x", read: {} } as never);
    show({ teamId: "olgu", hubTeamId: "simeray" });
    fireEvent.click(screen.getByRole("button", { name: "Take over in place" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/import"));
    expect(connect).toHaveBeenCalledWith({ teamId: "simeray", serverId: "hub" });
    expect(focus()).toMatchObject({ agentSessionId: "sess-5678abcd", inPlaceServerId: "s1" });
  });

  it("a guided run that already has its import opens the takeover on it and makes no session", async () => {
    vi.spyOn(api, "listMigrationRuns").mockResolvedValue([{ id: "r1", targetServerId: "s1", topology: "swap-proxy", dryRun: false, status: "RUNNING", createdAt: "2026-11-25T00:00:00Z" }] as never);
    vi.spyOn(api, "getMigrationRun").mockResolvedValue({ opId: "op1" } as never);
    const connect = vi.spyOn(api, "importConnectAgent");
    show();
    fireEvent.click(screen.getByRole("button", { name: "Take over in place" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/import/inplace?serverId=s1&opId=op1"));
    expect(connect).not.toHaveBeenCalled();
    expect(focus()).toBeNull();
  });

  it("a run that has not imported yet opens the run itself", async () => {
    vi.spyOn(api, "listMigrationRuns").mockResolvedValue([{ id: "r1", targetServerId: "s1", topology: "swap-proxy", dryRun: false, status: "WAITING", createdAt: "2026-11-25T00:00:00Z" }] as never);
    vi.spyOn(api, "getMigrationRun").mockResolvedValue({ opId: null } as never);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Take over in place" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/import/runs/r1"));
  });

  it("a takeover already on record is opened (labelled so), not started again", async () => {
    const connect = vi.spyOn(api, "importConnectAgent");
    show({ row: { serverId: "s1", name: "box", takeover: "FAILED" } });
    fireEvent.click(screen.getByRole("button", { name: "Open takeover" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/import/inplace?serverId=s1"));
    expect(connect).not.toHaveBeenCalled();
  });

  it("no Coolify host known: it says so and asks nothing of the hub", async () => {
    const connect = vi.spyOn(api, "importConnectAgent");
    show({ hubServerId: null });
    fireEvent.click(screen.getByRole("button", { name: "Take over in place" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Connect and read the Coolify host first.");
    expect(connect).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("a failed read shows a plain line, never the response text, and opens nothing", async () => {
    vi.spyOn(api, "importConnectAgent").mockRejectedValue(new ApiError(502, "RESPONSE-TEXT", "agent_read_failed"));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Take over in place" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not start the takeover. Try again in a moment.");
    expect(document.body.textContent).not.toContain("RESPONSE-TEXT");
    expect(nav.push).not.toHaveBeenCalled();
    expect(focus()).toBeNull();
    expect((screen.getByRole("button", { name: "Take over in place" }) as HTMLButtonElement).disabled).toBe(false); // it can be tried again
  });

  describe("a Coolify with several teams", () => {
    const MULTI = { sessionId: "sess-1111aaaa", expiresAt: "x", read: {}, teams: [{ ref: "1", name: "Alpha" }, { ref: "2", name: "Beta" }] };
    it("asks which team first and goes nowhere until one is picked; the pick starts a new session that carries it and ends the first", async () => {
      const connect = vi.spyOn(api, "importConnectAgent").mockResolvedValueOnce(MULTI as never).mockResolvedValueOnce({ ...MULTI, sessionId: "sess-2222bbbb" } as never);
      const revoke = vi.spyOn(api, "importRevoke").mockResolvedValue({ ok: true });
      show();
      fireEvent.click(screen.getByRole("button", { name: "Take over in place" }));
      await screen.findByTestId("take-over-team");
      expect(nav.push).not.toHaveBeenCalled();
      expect((screen.getByLabelText("Coolify team") as HTMLSelectElement).value).toBe("");
      const go = screen.getByRole("button", { name: "Continue to the takeover" }) as HTMLButtonElement;
      expect(go.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Coolify team"), { target: { value: "2" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue to the takeover" }));
      await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/import"));
      expect(connect).toHaveBeenLastCalledWith({ teamId: "t1", serverId: "hub", sourceTeamRef: "2" });
      expect(revoke).toHaveBeenCalledWith("sess-1111aaaa");
      expect(focus().agentSessionId).toBe("sess-2222bbbb");
    });
  });
});
