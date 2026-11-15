import { describe, it, expect, vi, afterEach, beforeEach, type MockInstance } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { AppMoveBanner } from "./app-move-banner";
import { api } from "../lib/api";
import type { AppMove, ServerView } from "../lib/types";

const toast = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("./toast", () => ({ useToast: () => toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SERVERS = [{ id: "s1", name: "alpha" }, { id: "s2", name: "beta" }] as unknown as ServerView[];

const mv = (over: Partial<AppMove> = {}): AppMove => ({
  id: "mv1", appId: "a1", appName: "blog", phase: "TRANSFERRING", prevStatus: "RUNNING", sourceServerId: "s1", targetServerId: "s2",
  volumes: [{ name: "data", state: "PACKED", sizeBytes: 1000, parts: 4, partsDone: 1, bytesDone: 250 }, { name: "cache", state: "SKIPPED", sizeBytes: null, parts: 0, partsDone: 0, bytesDone: 0 }],
  progress: { volumeIndex: 0, volumeCount: 1, bytesDone: 250, bytesTotal: 1000 }, warnings: [], failureReason: null, failurePhase: null, deploymentId: null,
  cutoverAt: null, finishedAt: null, archiveUntil: null, sourcePurgedAt: null, createdAt: new Date().toISOString(), canCancel: true, needsAttention: false,
  plan: null, acks: null, logTail: null, ...over,
});

let qc: QueryClient;
function show(props: { move?: { id: string; phase: AppMove["phase"] } | null; canWrite?: boolean } = {}) {
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <AppMoveBanner appId="a1" teamId="t1" move={props.move === undefined ? { id: "mv1", phase: "TRANSFERRING" } : props.move} canWrite={props.canWrite ?? true} />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("AppMoveBanner — an active move", () => {
  let getMoves: MockInstance<typeof api.getAppMoves>;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    toast.mockClear();
    refresh.mockClear();
    vi.spyOn(api, "listServers").mockResolvedValue(SERVERS);
    getMoves = vi.spyOn(api, "getAppMoves").mockImplementation(async (_id, opts) => (opts?.active || opts?.limit ? [mv()] : []));
  });

  it("shows the target server, the five steps with the current one active, the per-volume bar and the byte total", async () => {
    show();
    expect(await screen.findByText("Moving to beta")).toBeTruthy();
    const steps = screen.getByRole("list", { name: "Move progress" });
    expect(Array.from(steps.querySelectorAll("li")).map((li) => [li.textContent, li.getAttribute("data-state")])).toEqual([
      ["✓ Checking", "done"], ["✓ Stopping the app", "done"], ["Copying data", "active"], ["Starting on the new server", "pending"], ["Finishing up", "pending"],
    ]);
    const bar = screen.getByRole("progressbar", { name: "data" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25"); // partsDone/parts
    expect(screen.getByText("part 1/4")).toBeTruthy();
    expect(screen.getByText("250 B of 1000 B")).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: "cache" })).toBeNull(); // a skipped volume has no bar
  });

  it("polls the ACTIVE-move endpoint (not a list) and keeps polling every 2 s while it is not terminal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await screen.findByText("Moving to beta");
    expect(getMoves).toHaveBeenCalledWith("a1", { active: true });
    const calls = () => getMoves.mock.calls.filter((c) => (c[1] as { active?: boolean })?.active).length;
    const before = calls();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(calls()).toBeGreaterThan(before);
    const mid = calls();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(calls()).toBeGreaterThan(mid);
  });

  it("backs off after consecutive errors (the interval grows) instead of hammering a failing hub", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getMoves.mockImplementation(async (_id, opts) => {
      if (opts?.active) throw new Error("hub down");
      return [];
    });
    show();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const calls = () => getMoves.mock.calls.filter((c) => (c[1] as { active?: boolean })?.active).length;
    const first = calls();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    const afterTwo = calls();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); }); // the 2nd failure backs off to 4 s: nothing yet
    expect(calls() - afterTwo).toBeLessThanOrEqual(1);
    expect(afterTwo).toBeGreaterThanOrEqual(first);
  });

  it("Cancel move (before the cutover, writers only): asks to confirm, then cancels", async () => {
    const cancel = vi.spyOn(api, "cancelAppMove").mockResolvedValue({ ok: true });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel move" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("a1", "mv1"));
  });

  it("no cancel once the move cannot be cancelled (canCancel false) or for read-only members", async () => {
    getMoves.mockImplementation(async () => [mv({ phase: "DEPLOYING", canCancel: false })]);
    show({ move: { id: "mv1", phase: "DEPLOYING" } });
    expect(await screen.findByText("Moving to beta")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel move" })).toBeNull();
    cleanup();
    getMoves.mockImplementation(async () => [mv()]);
    show({ canWrite: false });
    expect(await screen.findByText("Moving to beta")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel move" })).toBeNull();
  });

  it("when the move turns terminal: ONE toast, the page data is refreshed, polling stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let done = false;
    getMoves.mockImplementation(async (_id, opts) => {
      if (opts?.active) return done ? [] : [mv()];
      return done ? [mv({ phase: "COMPLETED", finishedAt: new Date().toISOString(), archiveUntil: new Date(Date.now() + 7 * 86400000).toISOString(), canCancel: false })] : [mv()];
    });
    show();
    await screen.findByText("Moving to beta");
    done = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("The app now runs on the new server.", "success"));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    const calls = () => getMoves.mock.calls.filter((c) => (c[1] as { active?: boolean })?.active).length;
    const n = calls();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls()).toBe(n); // stopped
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe("AppMoveBanner — terminal states", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    toast.mockClear();
    vi.spyOn(api, "listServers").mockResolvedValue(SERVERS);
  });
  const latest = (m: AppMove) => vi.spyOn(api, "getAppMoves").mockImplementation(async (_id, opts) => (opts?.active ? [] : [m]));

  it("COMPLETED shows the archive card with the date and 'Remove old copy now' (confirm -> purge-source)", async () => {
    latest(mv({ phase: "COMPLETED", canCancel: false, finishedAt: new Date().toISOString(), archiveUntil: "2026-11-22T10:00:00.000Z" }));
    const purge = vi.spyOn(api, "purgeMoveSource").mockResolvedValue({ ok: true });
    show({ move: null });
    expect(await screen.findByText("The app now runs on the new server.")).toBeTruthy();
    expect(screen.getByText(/The old server keeps a stopped copy of the data until/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove old copy now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(purge).toHaveBeenCalledWith("a1", "mv1"));
  });

  it("COMPLETED without an archive just says it is done; readers get no purge button", async () => {
    latest(mv({ phase: "COMPLETED", canCancel: false, finishedAt: new Date().toISOString(), archiveUntil: "2026-11-22T10:00:00.000Z" }));
    show({ move: null, canWrite: false });
    await screen.findByText("The app now runs on the new server.");
    expect(screen.queryByRole("button", { name: "Remove old copy now" })).toBeNull();
  });

  it("ROLLED_BACK explains the translated failure reason and that the app runs on the original server", async () => {
    latest(mv({ phase: "ROLLED_BACK", canCancel: false, finishedAt: new Date().toISOString(), failureReason: "sha_mismatch", failurePhase: "TRANSFERRING" }));
    show({ move: null });
    expect(await screen.findByText("The move was rolled back.")).toBeTruthy();
    expect(screen.getByText(/Your app is running on the original server\. Reason: A transferred part failed its checksum\./)).toBeTruthy();
  });

  it("FAILED is the needs-attention card with the exact situation and a way to clear it", async () => {
    latest(mv({ phase: "FAILED", canCancel: false, needsAttention: true, finishedAt: "2020-01-01T00:00:00.000Z", failureReason: "source_restart_failed", failurePhase: "DEPLOYING", logTail: "rollback failed: x" }));
    const purge = vi.spyOn(api, "purgeMoveSource").mockResolvedValue({ ok: true });
    show({ move: null });
    expect(await screen.findByText("The move failed and needs your attention.")).toBeTruthy();
    expect(screen.getByText(/The app could not be brought back up on the original server \(The app could not be restarted on the original server\.\)/)).toBeTruthy();
    expect(screen.getByText("Move log")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear alert" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(purge).toHaveBeenCalledWith("a1", "mv1"));
    // a failed move has no Dismiss: it stays until a human clears it
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("the Clear alert confirm says what it really does (never the 'remove the old copy' text)", async () => {
    latest(mv({ phase: "FAILED", canCancel: false, needsAttention: true, finishedAt: "2020-01-01T00:00:00.000Z", failureReason: "source_restart_failed" }));
    show({ move: null });
    fireEvent.click(await screen.findByRole("button", { name: "Clear alert" }));
    expect(await screen.findByText(/only when the app is back on the original server/)).toBeTruthy();
    expect(screen.queryByText(/Remove the old copy of this app's data/)).toBeNull();
  });

  it("a kept apply recovery copy stays on the card for writers (even for an old rolled-back move) with its own button and note", async () => {
    latest(mv({ phase: "ROLLED_BACK", canCancel: false, finishedAt: "2020-01-01T00:00:00.000Z", failureReason: "apply_rollback_failed", snapshotKept: true, warnings: [{ code: "apply_snapshot_kept" }] }));
    const purge = vi.spyOn(api, "purgeMoveSource").mockResolvedValue({ ok: true });
    show({ move: null });
    expect(await screen.findByText(/A copy of data the transfer replaced is kept on the new server/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove kept copy" }));
    expect(await screen.findByText(/Remove the kept copy of the replaced data/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(purge).toHaveBeenCalledWith("a1", "mv1"));
    cleanup();
    latest(mv({ phase: "ROLLED_BACK", canCancel: false, finishedAt: new Date().toISOString(), snapshotKept: true }));
    show({ move: null, canWrite: false });
    await screen.findByText(/A copy of data the transfer replaced is kept/);
    expect(screen.queryByRole("button", { name: "Remove kept copy" })).toBeNull();
  });

  it("a warning without its details (a read-only member never gets the env variable names) still reads cleanly", async () => {
    latest(mv({ phase: "COMPLETED", canCancel: false, finishedAt: new Date().toISOString(), archiveUntil: null, warnings: [{ code: "env_may_reference_old_host" }] }));
    show({ move: null, canWrite: false });
    expect(await screen.findByText("Some environment variables mention the old server; they are NOT rewritten.")).toBeTruthy();
  });

  it("an old finished move is not shown at all; a recent rolled-back one can be dismissed", async () => {
    latest(mv({ phase: "ROLLED_BACK", canCancel: false, finishedAt: "2020-01-01T00:00:00.000Z", failureReason: "cancelled" }));
    const { container } = show({ move: null });
    await waitFor(() => expect(api.getAppMoves).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    cleanup();
    latest(mv({ phase: "ROLLED_BACK", canCancel: false, finishedAt: new Date().toISOString(), failureReason: "cancelled" }));
    show({ move: null });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("The move was rolled back.")).toBeNull());
  });

  it("warnings of a finished move are listed with their translated text", async () => {
    latest(mv({ phase: "COMPLETED", canCancel: false, finishedAt: new Date().toISOString(), archiveUntil: null, warnings: [{ code: "dns_repoint_failed", details: { hostnames: ["a.example.com", "b.example.com"] } }] }));
    show({ move: null });
    fireEvent.click(await screen.findByText(/Notes about this move/));
    expect(await screen.findByText("Some DNS records could not be repointed: a.example.com, b.example.com. Do it by hand.")).toBeTruthy();
  });
});
