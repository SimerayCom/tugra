"use client";

import { useState, type ReactNode } from "react";
import { useT } from "../i18n/provider";
import { entryNameProblem, gridToMode, isValidMode, modeToGrid, normalizeMode, type ModeGrid } from "../lib/file-utils";
import { Checkbox, Field, TextInput } from "./form";
import { Modal } from "./modal";
import { Btn } from "./ui";

/** Shared dialog chrome: a title, optional body, and a right-aligned action row. */
function DialogShell({ title, onClose, children, actions }: { title: string; onClose: () => void; children?: ReactNode; actions: ReactNode }) {
  return (
    <Modal onClose={onClose} zIndex={60} ariaLabel={title} closeOnBackdrop={false}>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", overflowWrap: "anywhere" }}>{title}</h2>
      {children}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 14 }}>{actions}</div>
    </Modal>
  );
}

function nameProblemKey(name: string): string | undefined {
  return name.length > 0 && entryNameProblem(name) ? "apps.files.nameInvalid" : undefined;
}

/** Create a file or a folder: validates ONE path segment (no "/", control chars, "."/"..", > 255 bytes). */
export function NewEntryDialog({
  kind,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  kind: "file" | "folder";
  busy?: boolean;
  error?: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const invalid = entryNameProblem(name) !== null;
  const submit = () => {
    if (!invalid && !busy) onSubmit(name);
  };
  const key = nameProblemKey(name);
  return (
    <DialogShell
      title={t(kind === "file" ? "apps.files.newFileTitle" : "apps.files.newFolderTitle")}
      onClose={onClose}
      actions={
        <>
          <Btn variant="ghost" onClick={onClose}>{t("apps.files.cancel")}</Btn>
          <Btn onClick={submit} disabled={invalid} loading={busy}>{t("apps.files.create")}</Btn>
        </>
      }
    >
      <Field label={t("apps.files.nameLabel")} htmlFor="file-new-name" error={key ? t(key) : error}>
        <TextInput
          id="file-new-name"
          value={name}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </Field>
    </DialogShell>
  );
}

export function RenameDialog({
  name,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  name: string;
  busy?: boolean;
  error?: string;
  onSubmit: (newName: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(name);
  const invalid = entryNameProblem(value) !== null || value === name;
  const submit = () => {
    if (!invalid && !busy) onSubmit(value);
  };
  const key = nameProblemKey(value);
  return (
    <DialogShell
      title={t("apps.files.renameTitle", { name })}
      onClose={onClose}
      actions={
        <>
          <Btn variant="ghost" onClick={onClose}>{t("apps.files.cancel")}</Btn>
          <Btn onClick={submit} disabled={invalid} loading={busy}>{t("apps.files.rename")}</Btn>
        </>
      }
    >
      <Field label={t("apps.files.renameTo")} htmlFor="file-rename-to" error={key ? t(key) : error}>
        <TextInput
          id="file-rename-to"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </Field>
    </DialogShell>
  );
}

const ROWS = ["owner", "group", "other"] as const;
const COLS = ["read", "write", "exec"] as const;
const COL_KEY = ["r", "w", "x"] as const;

/**
 * Permission editor: a 3x3 rwx grid kept in sync with a 3-4 digit octal input. Setuid/setgid/sticky are
 * unreachable (the grid has no such cells and the octal input rejects anything above 0777). Not recursive.
 */
export function ChmodDialog({
  name,
  initialMode,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  name: string;
  initialMode: string;
  busy?: boolean;
  error?: string;
  onSubmit: (mode: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [octal, setOctal] = useState(() => gridToMode(modeToGrid(initialMode)));
  const valid = isValidMode(octal);
  const grid: ModeGrid = valid ? modeToGrid(octal) : modeToGrid("0000");
  const toggle = (row: number, col: (typeof COL_KEY)[number]) => {
    const next = grid.map((g, i) => (i === row ? { ...g, [col]: !g[col] } : g)) as ModeGrid;
    setOctal(gridToMode(next));
  };
  const submit = () => {
    if (valid && !busy) onSubmit(normalizeMode(octal));
  };
  return (
    <DialogShell
      title={t("apps.files.permissionsTitle", { name })}
      onClose={onClose}
      actions={
        <>
          <Btn variant="ghost" onClick={onClose}>{t("apps.files.cancel")}</Btn>
          <Btn onClick={submit} disabled={!valid} loading={busy}>{t("apps.files.save")}</Btn>
        </>
      }
    >
      <table style={{ borderCollapse: "collapse", fontSize: 13, marginBottom: 12 }}>
        <thead>
          <tr>
            <th />
            {COLS.map((c) => (
              <th key={c} style={{ padding: "4px 10px", color: "var(--c-tx2)", fontWeight: 600, fontSize: 12 }}>{t(`apps.files.${c}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row, ri) => (
            <tr key={row}>
              <th scope="row" style={{ textAlign: "left", padding: "4px 10px 4px 0", color: "var(--c-tx2)", fontWeight: 600, fontSize: 12 }}>{t(`apps.files.${row}`)}</th>
              {COL_KEY.map((ck, ci) => (
                <td key={ck} style={{ textAlign: "center", padding: "4px 10px" }}>
                  <input
                    type="checkbox"
                    checked={grid[ri][ck]}
                    onChange={() => toggle(ri, ck)}
                    aria-label={`${t(`apps.files.${row}`)} ${t(`apps.files.${COLS[ci]}`)}`}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Field
        label={t("apps.files.modeLabel")}
        htmlFor="file-chmod-octal"
        hint={t("apps.files.modeHint")}
        error={!valid ? t("apps.files.modeHint") : error}
      >
        <TextInput
          id="file-chmod-octal"
          mono
          value={octal}
          inputMode="numeric"
          maxLength={4}
          autoComplete="off"
          onChange={(e) => setOctal(e.target.value.replace(/[^0-7]/g, "").slice(0, 4))}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </Field>
    </DialogShell>
  );
}

/**
 * Delete confirmation. A file gets a simple confirm. A directory is a RECURSIVE delete and needs the entry's name
 * typed. `notEmpty` (the server said the folder has contents) re-asks with the recursive wording.
 */
export function DeleteConfirmDialog({
  name,
  isDir,
  notEmpty,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  name: string;
  isDir: boolean;
  notEmpty?: boolean;
  busy?: boolean;
  error?: string;
  onConfirm: (recursive: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const recursive = isDir || !!notEmpty;
  const ok = !recursive || typed === name;
  return (
    <DialogShell
      title={t("apps.files.delete")}
      onClose={onClose}
      actions={
        <>
          <Btn variant="ghost" onClick={onClose}>{t("apps.files.cancel")}</Btn>
          <Btn variant="danger" disabled={!ok} loading={busy} onClick={() => ok && !busy && onConfirm(recursive)}>
            {t("apps.files.delete")}
          </Btn>
        </>
      }
    >
      {notEmpty && <p style={{ fontSize: 13, color: "var(--c-am)", margin: "0 0 8px" }}>{t("apps.files.deleteNotEmpty")}</p>}
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 12px", lineHeight: 1.5, overflowWrap: "anywhere" }}>
        {t(recursive ? "apps.files.deleteDir" : "apps.files.deleteFile", { name })}
      </p>
      {recursive && (
        <Field label={t("apps.files.deleteTypeName", { name })} htmlFor="file-delete-type" error={error}>
          <TextInput
            id="file-delete-type"
            value={typed}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ok && !busy) onConfirm(recursive);
            }}
          />
        </Field>
      )}
      {!recursive && error && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{error}</div>}
    </DialogShell>
  );
}

/** A file with that name already exists: overwrite it or skip this one. */
export function OverwriteDialog({ name, onOverwrite, onSkip }: { name: string; onOverwrite: () => void; onSkip: () => void }) {
  const t = useT();
  return (
    <DialogShell
      title={t("apps.files.overwrite")}
      onClose={onSkip}
      actions={
        <>
          <Btn variant="ghost" onClick={onSkip}>{t("apps.files.skip")}</Btn>
          <Btn variant="danger" onClick={onOverwrite}>{t("apps.files.overwrite")}</Btn>
        </>
      }
    >
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: 0, lineHeight: 1.5, overflowWrap: "anywhere" }}>{t("apps.files.overwriteBody", { name })}</p>
    </DialogShell>
  );
}

/** The app looks like a running database/broker: the change needs an explicit acknowledgement. */
export function DatastoreAckDialog({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  const t = useT();
  const [ack, setAck] = useState(false);
  return (
    <DialogShell
      title={t("apps.files.datastoreAckTitle")}
      onClose={onClose}
      actions={
        <>
          <Btn variant="ghost" onClick={onClose}>{t("apps.files.cancel")}</Btn>
          <Btn variant="danger" disabled={!ack} onClick={onConfirm}>{t("apps.files.retry")}</Btn>
        </>
      }
    >
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 12px", lineHeight: 1.5 }}>{t("apps.files.datastoreWarn")}</p>
      <Checkbox checked={ack} onChange={setAck} label={t("apps.files.datastoreAck")} />
    </DialogShell>
  );
}
