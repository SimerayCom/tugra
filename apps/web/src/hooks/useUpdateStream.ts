"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { consumeSseStream } from "../lib/sse";

export type UpdatePhase = "idle" | "starting" | "queued" | "pulling" | "recreating" | "done" | "failed";

const APPLY_MESSAGE: Record<string, string> = {
  "up-to-date": "settings.updateUpToDate",
  unconfigured: "settings.updateUnconfigured",
  "notify-only": "settings.updateNotifyOnly",
  "needs-intermediate": "settings.updateNeedsIntermediate",
  error: "settings.updateFailed",
};

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
  const abort = useRef<AbortController | null>(null);

  const reconcile = useCallback(
    async (targetVersion: string | null): Promise<void> => {
      for (let i = 0; i < 80; i++) {
        try {
          const st = await api.getInstanceUpdate();
          if (targetVersion && st.current === targetVersion) {
            setPhase("done");
            qc.invalidateQueries({ queryKey: ["instanceUpdate"] });
            return;
          }
        } catch {
          /* the hub is still restarting — keep polling */
        }
        await sleep(3000);
      }
      setPhase("failed");
      setMessageKey("settings.updateFailed");
    },
    [qc],
  );

  const start = useCallback(async () => {
    setMessageKey("");
    setPhase("starting");
    let res: Awaited<ReturnType<typeof api.applyInstanceUpdate>>;
    try {
      res = await api.applyInstanceUpdate();
    } catch (e) {
      setPhase("idle");
      setMessageKey(e instanceof ApiError && e.status === 409 ? "settings.updateInProgress" : "settings.updateFailed");
      if (!(e instanceof ApiError && e.status === 409)) setPhase("failed");
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
    let failed = false;
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
              const p = JSON.parse(raw) as { phase?: UpdatePhase };
              if (p.phase === "failed") failed = true;
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
    if (failed) {
      setPhase("failed");
      setMessageKey("settings.updateFailed");
      return;
    }
    // Reconcile via the running version — survives the recreate the SSE couldn't.
    await reconcile(res.targetVersion);
  }, [reconcile]);

  return { phase, target, messageKey, start };
}
