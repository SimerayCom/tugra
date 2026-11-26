import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { api, ApiError } from "../lib/api";
import { TeamScopeProvider } from "../components/team-scope";
import { useMoveOffVisible } from "./useMoveOffVisible";

const auth = vi.hoisted(() => ({ user: { id: "u1" } as { id: string } | null }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: auth.user }) }));

afterEach(cleanup);
let qc: QueryClient;
beforeEach(() => {
  vi.restoreAllMocks();
  auth.user = { id: "u1" };
  window.localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={qc}>
    <TeamScopeProvider>{children}</TeamScopeProvider>
  </QueryClientProvider>
);
const status = (coolify: boolean) => ({ teamId: "x", hub: null, servers: coolify ? [{ serverId: "s", name: "n", agentOnline: true, coolify: true, isCoolifyHub: false, takeover: "none", cleanup: "none", stage: "takeover" }] : [], campaigns: [], projectMoves: { total: 0, active: 0, completed: 0, failed: 0, latestPhase: null }, steps: [] }) as never;

describe("useMoveOffVisible", () => {
  it("is true once a team the person owns has Coolify in it", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "A", role: "OWNER" }, { id: "t2", name: "B", role: "ADMIN" }] as never);
    vi.spyOn(api, "coolifyMoveStatus").mockImplementation(async (id: string) => status(id === "t2"));
    const { result } = renderHook(() => useMoveOffVisible(), { wrapper });
    expect(result.current).toBe(false); // not before the answer is in
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("stays false when no team has Coolify, and asks nothing for teams the person only belongs to", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "A", role: "OWNER" }, { id: "t3", name: "C", role: "MEMBER" }] as never);
    const spy = vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(status(false));
    const { result } = renderHook(() => useMoveOffVisible(), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith("t1");
    expect(result.current).toBe(false);
  });

  it("makes no request for a person who owns or administers nothing, nor while signed out", async () => {
    const spy = vi.spyOn(api, "coolifyMoveStatus").mockResolvedValue(status(true));
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t3", name: "C", role: "MEMBER" }] as never);
    const { result } = renderHook(() => useMoveOffVisible(), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
    cleanup();
    qc.clear();
    auth.user = null;
    const list = vi.spyOn(api, "listTeams");
    list.mockClear();
    renderHook(() => useMoveOffVisible(), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(list).not.toHaveBeenCalled();
  });

  it("a status the hub refuses counts as no Coolify, not as an error", async () => {
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "A", role: "OWNER" }] as never);
    const spy = vi.spyOn(api, "coolifyMoveStatus").mockRejectedValue(new ApiError(403, "no"));
    const { result } = renderHook(() => useMoveOffVisible(), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current).toBe(false);
  });

  it("follows the team in view: a team without Coolify hides it even when another team has it", async () => {
    window.localStorage.setItem("tugra.teamScope", "t1");
    vi.spyOn(api, "listTeams").mockResolvedValue([{ id: "t1", name: "A", role: "OWNER" }, { id: "t2", name: "B", role: "OWNER" }] as never);
    const spy = vi.spyOn(api, "coolifyMoveStatus").mockImplementation(async (id: string) => status(id === "t2"));
    const { result } = renderHook(() => useMoveOffVisible(), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(spy.mock.calls.map((c) => c[0])).not.toContain("t2");
    expect(result.current).toBe(false);
  });
});
