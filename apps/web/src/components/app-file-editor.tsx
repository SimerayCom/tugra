"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { NotEditableError, downloadHref, fsErrorKey, readFileText, uploadFile, type FsTarget } from "../lib/files-api";
import { useT } from "../i18n/provider";
import { Modal } from "./modal";
import { Btn, Spinner } from "./ui";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "blocked"; reason: "binary" | "tooBig" | "encoding" | "lineEndings" }
  | { kind: "ready" };

/**
 * A plain <textarea> editor (no third-party editor) for ONE small text file. Loads with its ETag and saves with
 * `ifMatch`, so a concurrent change surfaces as a Reload / Overwrite-anyway bar instead of silently clobbering it.
 * Ctrl/Cmd+S saves; closing with unsaved edits asks first. Binary, too-large and non-UTF-8 files are refused with a
 * "download instead" hint. The trailing newline is preserved exactly, and a CRLF file keeps its CRLF line breaks.
 * A brand-new file (`isNew`) starts empty and is created (no overwrite) on first save.
 */
export function AppFileEditor({
  id,
  target,
  path,
  name,
  maxEditBytes,
  writable,
  isNew = false,
  requestAck,
  onClose,
  onSaved,
}: {
  id: string;
  target: FsTarget;
  path: string;
  name: string;
  maxEditBytes: number;
  writable: boolean;
  isNew?: boolean;
  /** Asks the user to acknowledge writing into a running datastore; resolves true to retry with acknowledgeRisk. */
  requestAck?: () => Promise<boolean>;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>(isNew ? { kind: "ready" } : { kind: "loading" });
  const [text, setText] = useState("");
  const baseRef = useRef("");
  const etagRef = useRef("");
  const crlfRef = useRef(false);
  const createdRef = useRef(!isNew); // false until a brand-new file has been written once
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = text !== baseRef.current;

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    setConflict(false);
    setError(null);
    try {
      const f = await readFileText(id, target, path, maxEditBytes);
      baseRef.current = f.text;
      etagRef.current = f.etag;
      crlfRef.current = f.crlf;
      setText(f.text);
      setPhase({ kind: "ready" });
    } catch (e) {
      if (e instanceof NotEditableError) setPhase({ kind: "blocked", reason: e.reason });
      else setPhase({ kind: "error", message: errorText(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, path, target.scope, target.name, maxEditBytes]);

  useEffect(() => {
    if (!isNew) void load();
  }, [isNew, load]);

  function errorText(e: unknown): string {
    const k = fsErrorKey(e);
    if (k) return t(k);
    return e instanceof Error ? e.message : t("apps.files.saveFailed");
  }

  const save = async (opts: { force?: boolean; ack?: boolean } = {}) => {
    if (!writable || saving || phase.kind !== "ready") return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const body = new Blob([crlfRef.current ? text.replace(/\n/g, "\r\n") : text]);
    try {
      const r = await uploadFile({
        id,
        target,
        path,
        body,
        overwrite: createdRef.current,
        ifMatch: createdRef.current && !opts.force && etagRef.current ? etagRef.current : undefined,
        acknowledgeRisk: opts.ack,
      }).promise;
      baseRef.current = text;
      etagRef.current = r.etag;
      createdRef.current = true;
      setConflict(false);
      setSaved(true);
      onSaved?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === "changed") setConflict(true);
      else if (e instanceof ApiError && e.code === "datastore_running" && requestAck) {
        setSaving(false);
        if (await requestAck()) await save({ ...opts, ack: true });
        return;
      } else setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (dirty && !window.confirm(t("apps.files.discard"))) return;
    onClose();
  };

  const title = t("apps.files.editing", { name });
  return (
    <Modal onClose={close} width={860} zIndex={60} ariaLabel={title} closeOnBackdrop={false} cardStyle={{ width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{title}</h2>
        {dirty && phase.kind === "ready" && <span style={{ fontSize: 12, color: "var(--c-am)" }}>{t("apps.files.unsaved")}</span>}
        {saved && !dirty && <span role="status" style={{ fontSize: 12, color: "var(--c-g)" }}>{t("apps.files.saved")}</span>}
      </div>

      {phase.kind === "loading" && (
        <div role="status" aria-label={t("apps.files.loadingFile")} style={{ display: "flex", justifyContent: "center", padding: 28 }}>
          <Spinner />
        </div>
      )}

      {phase.kind === "error" && (
        <div role="alert" style={{ fontSize: 13, color: "var(--c-r)", marginBottom: 10 }}>
          {phase.message}
          <div style={{ marginTop: 8 }}>
            <Btn variant="ghost" onClick={() => void load()}>{t("apps.files.retry")}</Btn>
          </div>
        </div>
      )}

      {phase.kind === "blocked" && (
        <div style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5, marginBottom: 10 }}>
          <p style={{ margin: "0 0 10px" }}>
            {t(
              phase.reason === "binary"
                ? "apps.files.binaryNoEdit"
                : phase.reason === "tooBig"
                  ? "apps.files.tooBigNoEdit"
                  : phase.reason === "lineEndings"
                    ? "apps.files.lineEndingsNoEdit"
                    : "apps.files.encodingNoEdit",
            )}
          </p>
          <a href={downloadHref(id, target, path)} download style={{ color: "var(--c-lapis)", fontWeight: 600 }}>{t("apps.files.download")}</a>
        </div>
      )}

      {phase.kind === "ready" && (
        <>
          {conflict && (
            <div role="alert" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 10px", marginBottom: 10, border: "1px solid var(--c-am)", borderRadius: "var(--r1)", fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 160 }}>{t("apps.files.changedOnDisk")}</span>
              <Btn variant="ghost" onClick={() => void load()}>{t("apps.files.reload")}</Btn>
              <Btn variant="danger" onClick={() => void save({ force: true })}>{t("apps.files.overwriteAnyway")}</Btn>
            </div>
          )}
          {error && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginBottom: 8 }}>{error}</div>}
          <textarea
            aria-label={title}
            value={text}
            readOnly={!writable}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void save();
              }
            }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              minHeight: 280,
              height: "55vh",
              resize: "vertical",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 12.5,
              lineHeight: 1.5,
              tabSize: 2,
              whiteSpace: "pre",
              overflow: "auto",
              padding: 10,
              background: "var(--c-el)",
              color: "var(--c-tx)",
              border: "1px solid var(--c-bd)",
              borderRadius: "var(--r1)",
            }}
          />
        </>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={close}>{t("apps.files.close")}</Btn>
        {phase.kind === "ready" && writable && (
          <Btn onClick={() => void save()} disabled={!dirty && createdRef.current} loading={saving}>{t("apps.files.save")}</Btn>
        )}
      </div>
    </Modal>
  );
}
