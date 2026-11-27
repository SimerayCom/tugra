"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { consumeSseStream } from "../lib/sse";
import { heldFromError } from "../lib/in-flight";
import type { InFlightItem } from "../lib/types";

/** `reconnecting` is client-side only: the stream dropped (hub restarting) and we're polling the version. */
export type UpdatePhase = "idle" | "starting" | "queued" | "pulling" | "recreating" | "reconnecting" | "done" | "failed" | "recovery_required";

export type UpdateStepId = "queued" | "pulling" | "recreating" | "reconnecting";
export type UpdateStepState = "pending" | "active" | "done" | "failed";
export const UPDATE_STEP_IDS: readonly UpdateStepId[] = ["queued", "pulling", "recreating", "reconnecting"];

/** The stepper step a working phase belongs to (`starting` is the pre-queue handshake, shown as step 1). */
export function stepOfPhase(phase: UpdatePhase): UpdateStepId | null {
  switch (phase) {
    case "starting":
    case "queued":
      return "queued";
    case "pulling":
    case "recreating":
    case "reconnecting":
      return phase;
    default:
      return null;
  }
}

/**
 * Pure phase → stepper mapping. Working phases: earlier steps done, the current one active, later ones
 * pending. `done`: everything done. `failed`/`recovery_required`: steps before `failedStep` are done, that
 * step is failed, the rest pending (`failedStep` defaults to the first step). `idle`: all pending.
 */
export function updateSteps(phase: UpdatePhase, failedStep: UpdateStepId | null = null): { id: UpdateStepId; state: UpdateStepState }[] {
  const idx = (id: UpdateStepId) => UPDATE_STEP_IDS.indexOf(id);
  return UPDATE_STEP_IDS.map((id) => {
    if (phase === "done") return { id, state: "done" as const };
    if (phase === "failed" || phase === "recovery_required") {
      const f = idx(failedStep ?? "queued");
      return { id, state: idx(id) < f ? ("done" as const) : idx(id) === f ? ("failed" as const) : ("pending" as const) };
    }
    const cur = stepOfPhase(phase);
    if (!cur) return { id, state: "pending" as const };
    return { id, state: idx(id) < idx(cur) ? ("done" as const) : idx(id) === idx(cur) ? ("active" as const) : ("pending" as const) };
  });
}

/** mm:ss (minutes keep growing past 59 — an update never needs an hours field). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const APPLY_MESSAGE: Record<string, string> = {
  "up-to-date": "settings.updateUpToDate",
  unconfigured: "settings.updateUnconfigured",
  "notify-only": "settings.updateNotifyOnly",
  "needs-intermediate": "settings.updateNeedsIntermediate",
  error: "settings.updateFailed",
};

/**
 * Why an update ended in `failed` / `recovery_required`, as the update helper reported it in its last status frame:
 * `error` is the human cause, `code` its machine kind (`disk_space`: the preflight refused, or the disk filled up while
 * pulling), with the measured `needBytes` / `haveBytes` and the `path` when the helper knew them.
 */
export interface UpdateFailure {
  error: string | null;
  code: string | null;
  needBytes: number | null;
  haveBytes: number | null;
  path: string | null;
}

/** One SSE status frame -> the failure detail it carries (wrong-typed fields dropped). Pure. */
export function parseFailure(p: Record<string, unknown>): UpdateFailure {
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  return { error: str(p.error), code: str(p.code), needBytes: num(p.needBytes), haveBytes: num(p.haveBytes), path: str(p.path) };
}

/** Bytes as the "19.6 GB" / "512 MB" the update helper prints (binary units), so the panel and the server log agree. Pure. */
export function formatBytes(bytes: number): string {
  const gib = 1024 ** 3;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * The i18n key + params that explain a failed update. Never the bare "update failed": a disk shortfall names the numbers and the
 * path, any other cause the helper reported is quoted, and only a failure with no reported cause at all falls back to the
 * generic text. Pure.
 */
export function failureMessage(f: UpdateFailure | null, fallbackKey: string): { key: string; params?: Record<string, string> } {
  if (f?.code === "disk_space") {
    if (f.needBytes != null && f.haveBytes != null && f.path) {
      return { key: "settings.updateDiskShort", params: { need: formatBytes(f.needBytes), have: formatBytes(f.haveBytes), path: f.path } };
    }
    return { key: "settings.updateDiskFull" };
  }
  if (f?.error) return { key: "settings.updateFailedReason", params: { reason: f.error } };
  return { key: fallbackKey };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The SSE is best-effort progress. A healthy update tears it down within seconds when hub-api is recreated;
// but a sidecar that dies mid-pull (OOM, docker hang) leaves the status frozen and the stream open forever.
// Cap how long we wait on it so the authoritative version-poll reconcile always runs.
const SSE_MAX_MS = 15 * 60 * 1000;

/**
 * Drives the "Update now" flow: POST /instance/update, then follow live progress over SSE. The SSE drops
 * when hub-api is recreated mid-update (expected) — we then poll GET /instance/update until the running
 * version reaches the target (the reliable completion signal). `messageKey` is an i18n key for non-started
 * outcomes (already up to date, unconfigured, a minor/major that needs an explicit click, etc.).
 */
export function useUpdateStream() {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [target, setTarget] = useState<string | null>(null);
  const [messageKey, setMessageKey] = useState<string>("");
  const [failedStep, setFailedStep] = useState<UpdateStepId | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [failure, setFailure] = useState<UpdateFailure | null>(null);
  // The hub answered 409 `migration-active`: what is running. The card asks "Update anyway?" and calls start({ force: true }).
  const [held, setHeld] = useState<InFlightItem[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The last working step reached, so a failure can mark WHICH step failed.
  const lastStep = useRef<UpdateStepId>("queued");
  const finish = useCallback((p: UpdatePhase, failed?: boolean) => {
    if (failed) setFailedStep(lastStep.current);
    setPhase(p);
    setEndedAt(Date.now());
  }, []);

  const reconcile = useCallback(
    async (targetVersion: string | null): Promise<void> => {
      for (let i = 0; i < 80; i++) {
        try {
          const st = await api.getInstanceUpdate();
          if (targetVersion && st.current === targetVersion) {
            finish("done");
            qc.invalidateQueries({ queryKey: ["instanceUpdate"] });
            return;
          }
        } catch {
          /* the hub is still restarting — keep polling */
        }
        await sleep(3000);
      }
      finish("failed", true);
      setMessageKey("settings.updateTimedOut");
    },
    [qc, finish],
  );

  const start = useCallback(async (opts?: { force?: boolean }) => {
    setHeld(null);
    setMessageKey("");
    setFailedStep(null);
    setFailure(null);
    setEndedAt(null);
    setStartedAt(Date.now());
    lastStep.current = "queued";
    setPhase("starting");
    let res: Awaited<ReturnType<typeof api.applyInstanceUpdate>>;
    try {
      res = await api.applyInstanceUpdate(opts?.force === true);
    } catch (e) {
      const running = heldFromError(e);
      if (running) {
        setPhase("idle");
        setStartedAt(null);
        setHeld(running);
        return;
      }
      setPhase("idle");
      setMessageKey(e instanceof ApiError && e.status === 409 ? "settings.updateInProgress" : "settings.updateFailed");
      if (!(e instanceof ApiError && e.status === 409)) finish("failed", true);
      return;
    }
    setTarget(res.targetVersion);
    if (res.status !== "started") {
      setPhase("idle");
      setMessageKey(APPLY_MESSAGE[res.status] ?? "settings.updateFailed");
      return;
    }

    setPhase("queued");
    // Best-effort live progress. The stream is torn down when hub-api is recreated — that's expected.
    let sawDone = false;
    let terminal: UpdatePhase | null = null; // failed OR recovery_required — a terminal non-success
    let detail: UpdateFailure | null = null; // the cause carried by that terminal frame
    const ctrl = new AbortController();
    abort.current = ctrl;
    const streamDone = (async () => {
      try {
        const resp = await fetch("/api/v1/instance/update/stream", {
          headers: { accept: "text/event-stream" },
          credentials: "include",
          signal: ctrl.signal,
        });
        if (resp.body) {
          await consumeSseStream(resp.body, (raw) => {
            try {
              const p = JSON.parse(raw) as { phase?: UpdatePhase } & Record<string, unknown>;
              if (p.phase === "failed" || p.phase === "recovery_required") {
                terminal = p.phase;
                detail = parseFailure(p);
              }
              if (p.phase === "done") sawDone = true;
              const step = p.phase ? stepOfPhase(p.phase) : null;
              if (step) lastStep.current = step;
              if (p.phase && p.phase !== "idle") setPhase(p.phase);
            } catch {
              /* ignore malformed frame */
            }
          });
        }
      } catch {
        /* SSE drop at recreate is expected */
      }
    })();
    // Never block reconcile on a stream that can hang indefinitely if the sidecar dies without recreating.
    let capId: ReturnType<typeof setTimeout>;
    const cap = new Promise<void>((r) => {
      capId = setTimeout(r, SSE_MAX_MS);
    });
    await Promise.race([streamDone, cap]);
    clearTimeout(capId!);
    ctrl.abort(); // tear down the fetch if the cap won the race
    if (terminal) {
      // Don't reconcile a terminal failure as if it might still succeed. recovery_required keeps its own
      // message (the stack may be partly updated — manual recovery needed).
      finish(terminal, true);
      setFailure(detail);
      qc.invalidateQueries({ queryKey: ["instanceUpdate"] }); // a half state may just have been repaired (or newly found)
      setMessageKey(terminal === "recovery_required" ? "settings.updateRecoveryRequired" : "settings.updateFailed");
      return;
    }
    // Reconcile via the running version — survives the recreate the SSE couldn't.
    if (!sawDone) {
      lastStep.current = "reconnecting";
      setPhase("reconnecting");
    }
    await reconcile(res.targetVersion);
  }, [reconcile, finish, qc]);

  const dismissHeld = useCallback(() => setHeld(null), []);

  return { phase, target, messageKey, failedStep, failure, startedAt, endedAt, start, held, dismissHeld };
}
