"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { fmtBytes } from "../lib/fleet";
import { UploadAbortedError, uploadFile, type FsTarget, type UploadHandle } from "../lib/files-api";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";

export type UploadStatus = "queued" | "uploading" | "applying" | "done" | "failed" | "skipped" | "conflict" | "needsAck";

export interface UploadItem {
  uid: number;
  name: string;
  size: number;
  target: FsTarget;
  path: string;
  status: UploadStatus;
  loaded: number;
  error?: string;
  overwrite: boolean;
  ack: boolean;
  /** a failed upload whose file is still held (a too-large file is not) */
  retryable: boolean;
  /** 429 (rate limit / server busy) backoff: do not start before this time (ms epoch); a counter caps the retries */
  notBefore?: number;
  throttled: number;
}

export const MAX_PARALLEL_UPLOADS = 2; // matches the hub's per-user concurrent-upload cap (FILES_MAX_CONCURRENT_UPLOADS)
/** How many times one file is automatically retried after a 429 before it is shown as failed. */
export const MAX_THROTTLE_RETRIES = 30;

/**
 * The upload queue: at most `maxParallel` files in flight, per-file progress and cancel/retry, a client-side size
 * gate, and the two recoverable server answers handled in place — 409 `exists` (ask Overwrite / Skip, then retry
 * with overwrite=1) and 409 `datastore_running` (ask for the acknowledgement, then retry with acknowledgeRisk=1).
 */
export function useUploadQueue(cfg: {
  id: string;
  maxBytes: number;
  maxParallel?: number;
  /** localized text for a failed upload */
  describeError: (e: unknown) => string;
  tooLargeText: (size: number) => string;
  onChanged: () => void;
}) {
  const { id, maxBytes, describeError, tooLargeText, onChanged } = cfg;
  const maxParallel = cfg.maxParallel ?? MAX_PARALLEL_UPLOADS;
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const handles = useRef(new Map<number, UploadHandle>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const files = useRef(new Map<number, File>());
  const seq = useRef(0);
  const cfgRef = useRef({ describeError, onChanged });
  cfgRef.current = { describeError, onChanged };

  const commit = useCallback((next: UploadItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const patch = useCallback(
    (uid: number, p: Partial<UploadItem>) => commit(itemsRef.current.map((it) => (it.uid === uid ? { ...it, ...p } : it))),
    [commit],
  );

  const pump = useCallback(() => {
    let running = handles.current.size;
    for (const it of itemsRef.current) {
      if (running >= maxParallel) break;
      if (it.status !== "queued") continue;
      if (it.notBefore && it.notBefore > Date.now()) continue; // backing off after a 429
      const file = files.current.get(it.uid);
      if (!file) continue;
      running++;
      patch(it.uid, { status: "uploading", loaded: 0, error: undefined });
      const h = uploadFile({
        id,
        target: it.target,
        path: it.path,
        body: file,
        overwrite: it.overwrite,
        acknowledgeRisk: it.ack,
        onProgress: (loaded, total) => patch(it.uid, { loaded, status: loaded >= total ? "applying" : "uploading" }),
      });
      handles.current.set(it.uid, h);
      h.promise.then(
        () => {
          handles.current.delete(it.uid);
          files.current.delete(it.uid);
          patch(it.uid, { status: "done", loaded: it.size });
          cfgRef.current.onChanged();
          pump();
        },
        (e: unknown) => {
          handles.current.delete(it.uid);
          if (e instanceof UploadAbortedError) {
            files.current.delete(it.uid);
            commit(itemsRef.current.filter((x) => x.uid !== it.uid));
          } else if (e instanceof ApiError && e.status === 429 && it.throttled < MAX_THROTTLE_RETRIES) {
            // Rate limited or the server is busy: honour Retry-After (the hub reports retryAfterSec) and try again by
            // itself — a folder drop is far more than a person would retry by hand.
            const secs = typeof e.data?.retryAfterSec === "number" ? e.data.retryAfterSec : e.code === "busy" ? 3 : 5;
            const delay = Math.min(Math.max(secs, 0.05), 120) * 1000;
            patch(it.uid, { status: "queued", throttled: it.throttled + 1, notBefore: Date.now() + delay, error: undefined });
            const tm = setTimeout(() => {
              timers.current.delete(tm);
              pump();
            }, delay + 10);
            timers.current.add(tm);
          } else if (e instanceof ApiError && e.code === "exists") patch(it.uid, { status: "conflict" });
          else if (e instanceof ApiError && e.code === "datastore_running") patch(it.uid, { status: "needsAck" });
          else patch(it.uid, { status: "failed", error: cfgRef.current.describeError(e), retryable: true });
          pump();
        },
      );
    }
  }, [id, maxParallel, patch, commit]);

  /** Queue files for upload into `dir` (the entry path is `joinPath`-built by the caller via `pathOf`). */
  const add = useCallback(
    (list: File[], target: FsTarget, pathOf: (name: string) => string) => {
      const next = [...itemsRef.current];
      for (const f of list) {
        const uid = ++seq.current;
        const tooBig = f.size > maxBytes;
        if (!tooBig) files.current.set(uid, f);
        next.push({
          uid,
          name: f.name,
          size: f.size,
          target,
          path: pathOf(f.name),
          status: tooBig ? "failed" : "queued",
          loaded: 0,
          error: tooBig ? tooLargeText(maxBytes) : undefined,
          overwrite: false,
          ack: false,
          retryable: false,
          throttled: 0,
        });
      }
      commit(next);
      pump();
    },
    [maxBytes, tooLargeText, commit, pump],
  );

  const cancel = useCallback(
    (uid: number) => {
      const h = handles.current.get(uid);
      if (h) {
        h.abort(); // its rejection removes the row and pumps
        return;
      }
      files.current.delete(uid);
      commit(itemsRef.current.filter((x) => x.uid !== uid));
    },
    [commit],
  );

  const retry = useCallback(
    (uid: number) => {
      if (!files.current.has(uid)) return;
      patch(uid, { status: "queued", error: undefined, loaded: 0, throttled: 0, notBefore: undefined });
      pump();
    },
    [patch, pump],
  );

  const resolveConflict = useCallback(
    (uid: number, choice: "overwrite" | "skip") => {
      if (choice === "skip") {
        files.current.delete(uid);
        patch(uid, { status: "skipped" });
        return;
      }
      patch(uid, { status: "queued", overwrite: true });
      pump();
    },
    [patch, pump],
  );

  const resolveAck = useCallback(
    (uid: number, ok: boolean) => {
      if (!ok) {
        patch(uid, { status: "failed", error: cfgRef.current.describeError(new ApiError(409, "", "datastore_running")), retryable: true });
        return;
      }
      patch(uid, { status: "queued", ack: true });
      pump();
    },
    [patch, pump],
  );

  const clearFinished = useCallback(
    () => commit(itemsRef.current.filter((x) => x.status !== "done" && x.status !== "skipped" && x.status !== "failed")),
    [commit],
  );

  // Abort anything still in flight when the card goes away.
  useEffect(() => {
    const hs = handles.current;
    const ts = timers.current;
    return () => {
      for (const h of hs.values()) h.abort();
      for (const tm of ts) clearTimeout(tm);
    };
  }, []);

  return {
    items,
    add,
    cancel,
    retry,
    resolveConflict,
    resolveAck,
    clearFinished,
    conflict: items.find((i) => i.status === "conflict"),
    needsAck: items.find((i) => i.status === "needsAck"),
  };
}

/** The panel listing every queued/in-flight/finished upload with its progress, status and actions. */
export function UploadQueuePanel({
  items,
  onCancel,
  onRetry,
  onClear,
}: {
  items: UploadItem[];
  onCancel: (uid: number) => void;
  onRetry: (uid: number) => void;
  onClear: () => void;
}) {
  const t = useT();
  if (items.length === 0) return null;
  const finished = items.some((i) => i.status === "done" || i.status === "skipped" || i.status === "failed");
  return (
    <section aria-label={t("apps.files.queueTitle")} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{t("apps.files.queueTitle")}</div>
        {finished && <Btn variant="ghost" onClick={onClear}>{t("apps.files.queueClear")}</Btn>}
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {items.map((it) => {
          const pct = it.size > 0 ? Math.min(100, Math.floor((it.loaded / it.size) * 100)) : it.status === "done" ? 100 : 0;
          const active = it.status === "uploading" || it.status === "applying" || it.status === "queued" || it.status === "conflict" || it.status === "needsAck";
          const backoff = it.status === "queued" && it.notBefore && it.notBefore > Date.now() ? Math.ceil((it.notBefore - Date.now()) / 1000) : 0;
          const label =
            backoff > 0
              ? t("apps.files.queueRetrying", { seconds: backoff })
              : it.status === "queued" || it.status === "conflict" || it.status === "needsAck"
              ? t("apps.files.queueQueued")
              : it.status === "uploading"
                ? t("apps.files.queueUploading", { percent: pct })
                : it.status === "applying"
                  ? t("apps.files.queueApplying")
                  : it.status === "done"
                    ? t("apps.files.queueDone")
                    : it.status === "skipped"
                      ? t("apps.files.queueSkipped")
                      : t("apps.files.queueFailed");
          return (
            <li key={it.uid} style={{ fontSize: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.name}>{it.name}</span>
                <span className="mono" style={{ color: "var(--c-tx3)", flexShrink: 0 }}>{fmtBytes(it.size)}</span>
                {active && (
                  <Btn variant="ghost" aria-label={t("apps.files.queueCancel", { name: it.name })} onClick={() => onCancel(it.uid)}>
                    {t("apps.files.cancel")}
                  </Btn>
                )}
                {it.status === "failed" && it.retryable && (
                  <Btn variant="ghost" aria-label={t("apps.files.queueRetry", { name: it.name })} onClick={() => onRetry(it.uid)}>
                    {t("apps.files.retry")}
                  </Btn>
                )}
              </div>
              <div
                role="progressbar"
                aria-label={it.name}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                style={{ height: 4, borderRadius: 2, background: "var(--c-bd)", margin: "4px 0", overflow: "hidden" }}
              >
                <div style={{ width: `${pct}%`, height: "100%", background: it.status === "failed" ? "var(--c-r)" : "var(--c-a)", transition: "width .15s" }} />
              </div>
              <div style={{ color: it.status === "failed" ? "var(--c-r)" : "var(--c-tx3)" }}>{it.error ?? label}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
