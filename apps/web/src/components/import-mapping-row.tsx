"use client";

import { useEffect, useRef, useState } from "react";
import { Box, CircleAlert, Database, RotateCcw, TriangleAlert } from "lucide-react";
import { useT } from "../i18n/provider";
import { checkAlias, isValidDbIdentifier, validateName, type ItemField } from "../lib/import-mapping";
import type { ImportConflict, ImportEffectiveItem, ImportMappingItem, ImportPlanItem } from "../lib/types";
import { ResourceIcon } from "./resource-icon";
import { importItemIcon } from "../lib/import-icon";
import { ProjectPicker, type ProjectChoice } from "./project-picker";

const cellInput: React.CSSProperties = { width: "100%", minHeight: 44, padding: "8px 10px", fontSize: 14, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontFamily: "inherit", boxSizing: "border-box" };
const STATUS_KEY = { pending: "pending", blocked: "blocked", already_imported: "alreadyImported", excluded: "excluded" } as const;

/** One editable cell. The draft is local: Enter or leaving the field commits, Esc reverts. The advisory check gives
 *  instant feedback (the hub's resolve stays authoritative). */
function Cell({ id, label, value, placeholder, error: serverError, check, hint, list, disabled, changed, onCommit, onReset }: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  /** the hub's (authoritative) error for this cell, shown while the draft equals the committed value */
  error?: string | null;
  /** instant advisory check of the DRAFT: a message, or null when fine */
  check?: (draft: string) => string | null;
  hint?: string;
  list?: string;
  disabled?: boolean;
  changed?: boolean;
  onCommit: (v: string) => void;
  onReset?: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const seen = useRef(value);
  useEffect(() => {
    if (value !== seen.current) {
      seen.current = value;
      setDraft(value);
    }
  }, [value]);
  const error = check?.(draft) ?? (draft === value ? serverError : null);
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
        <label htmlFor={id} style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1 }}>{label}</label>
        {changed && onReset && (
          <button type="button" onClick={onReset} aria-label={t("import.review.resetField", { field: label })} title={t("import.review.reset")} style={{ all: "unset", cursor: "pointer", minWidth: 24, minHeight: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--c-tx3)" }}>
            <RotateCcw size={12} aria-hidden />
          </button>
        )}
      </div>
      <input
        id={id}
        style={{ ...cellInput, ...(error ? { borderColor: "var(--c-r)" } : {}) }}
        value={draft}
        placeholder={placeholder}
        list={list}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            e.stopPropagation();
            setDraft(value);
          }
        }}
      />
      {error ? (
        <div id={`${id}-err`} style={{ display: "flex", gap: 4, alignItems: "flex-start", fontSize: 11, color: "var(--c-r)", marginTop: 2 }}>
          <CircleAlert size={12} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /> <span>{error}</span>
        </div>
      ) : hint ? (
        <div id={`${id}-hint`} style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 2 }}>{hint}</div>
      ) : null}
    </div>
  );
}

/** The project cell: the shared project picker (existing projects, "+ New project" first) in the row's cell layout. An empty choice
 *  means "no override": the project the source already puts the item in. */
function ProjectCell({ id, label, value, noneLabel, projects, error, changed, disabled, onCommit, onReset }: {
  id: string;
  label: string;
  value: string;
  noneLabel: string;
  projects: ProjectChoice[];
  error?: string | null;
  changed?: boolean;
  disabled?: boolean;
  onCommit: (v: string) => void;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
        <label htmlFor={id} style={{ fontSize: 11, color: "var(--c-tx3)", flex: 1 }}>{label}</label>
        {changed && (
          <button type="button" onClick={onReset} aria-label={t("import.review.resetField", { field: label })} title={t("import.review.reset")} style={{ all: "unset", cursor: "pointer", minWidth: 24, minHeight: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--c-tx3)" }}>
            <RotateCcw size={12} aria-hidden />
          </button>
        )}
      </div>
      <ProjectPicker id={id} value={value} projects={projects} noneLabel={noneLabel} disabled={disabled} invalid={!!error} describedBy={error ? `${id}-err` : undefined} onChange={onCommit} />
      {error && (
        <div id={`${id}-err`} style={{ display: "flex", gap: 4, alignItems: "flex-start", fontSize: 11, color: "var(--c-r)", marginTop: 2 }}>
          <CircleAlert size={12} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /> <span>{error}</span>
        </div>
      )}
    </div>
  );
}

/** One import item: include checkbox, source name (read-only), and the editable name / project / environment /
 *  alias cells. Responsive: the cells wrap into a card on narrow screens (touch targets are 44px). */
export function ImportMappingRow({
  item,
  eff,
  entry,
  conflicts,
  rowKey,
  projects,
  onEdit,
  onReset,
}: {
  item: ImportPlanItem;
  eff?: ImportEffectiveItem;
  entry?: ImportMappingItem;
  conflicts: ImportConflict[];
  rowKey: string;
  /** What the project picker offers (the target team's projects, the ones this import will create). */
  projects: ProjectChoice[];
  onEdit: (field: ItemField, value: string | boolean | null | undefined) => void;
  onReset: () => void;
}) {
  const t = useT();
  const kind = item.kind === "database" ? "database" : "app";
  const included = entry?.include !== false;
  const nameVal = entry?.name ?? item.name;
  const KindIcon = kind === "database" ? Database : Box;
  const brand = importItemIcon(item);

  const nameChk = (v: string) => {
    const r = validateName(kind, v);
    return r.ok ? null : t(`import.conflict.${r.code}`, { max: kind === "database" ? 60 : 100 });
  };
  const optChk = (k: "environment") => (v: string) => {
    if (!v) return null;
    const r = validateName(k, v);
    return r.ok ? null : t(`import.conflict.${r.code}`, { max: 80 });
  };
  const aliasRaw = typeof entry?.containerAlias === "string" ? entry.containerAlias : "";
  const aliasChk = (v: string) => {
    const r = v ? checkAlias(v) : "ok";
    return r === "ok" ? null : t(`import.conflict.${r}`);
  };
  const dbIdent = entry?.dbIdentifier ?? "";
  const dbIdentChk = (v: string) => (v && !isValidDbIdentifier(v) ? t("import.conflict.db.identifier_invalid") : null);

  const errs = conflicts.filter((c) => c.level === "error");
  const warns = conflicts.filter((c) => c.level === "warn");
  const status = eff ? t(`import.review.status.${STATUS_KEY[eff.status]}`) : null;
  const fieldError = (f: ImportConflict["field"]) => {
    const c = errs.find((x) => x.field === f);
    return c ? t(`import.conflict.${c.code}`, c.params) : null;
  };

  return (
    <div
      role="group"
      aria-label={t("import.review.rowFor", { name: item.name })}
      data-itemref={item.itemRef}
      tabIndex={-1}
      style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, opacity: included ? 1 : 0.7, background: errs.length ? "color-mix(in srgb, var(--c-r) 5%, transparent)" : undefined }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 44, cursor: "pointer" }}>
          <input type="checkbox" checked={included} onChange={(e) => onEdit("include", e.target.checked)} aria-label={t("import.review.includeFor", { name: item.name })} style={{ width: 20, height: 20 }} />
          <span aria-hidden style={{ width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <ResourceIcon image={brand.image} brand={brand.brand} name={item.name} size={20} fallback={<KindIcon size={14} style={{ color: "var(--c-tx3)" }} />} />
          </span>
          <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{kind === "database" ? t("import.review.kindDatabase") : t("import.review.kindApp")}</span>
        </label>
        <span className="mono" style={{ fontSize: 12, color: "var(--c-tx3)", wordBreak: "break-all", flex: 1, minWidth: 120 }}>{item.name}</span>
        {status && <span style={{ fontSize: 11, border: "1px solid var(--c-bd)", borderRadius: 10, padding: "2px 8px" }}>{status}</span>}
        {(errs.length > 0 || warns.length > 0) && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: errs.length ? "var(--c-r)" : "var(--c-am)" }}>
            {errs.length ? <CircleAlert size={13} aria-hidden /> : <TriangleAlert size={13} aria-hidden />}
            {errs.length > 0 ? t("import.conflict.level.error") : t("import.conflict.level.warn")} {errs.length + warns.length}
          </span>
        )}
        {(entry && Object.keys(entry).length > 0) && (
          <button type="button" onClick={onReset} style={{ all: "unset", cursor: "pointer", fontSize: 11, textDecoration: "underline", minHeight: 24 }}>{t("import.review.reset")}</button>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8 }}>
        <Cell
          id={`${rowKey}-name`}
          label={t("import.review.col.name")}
          value={nameVal}
          disabled={!included}
          check={nameChk}
          error={fieldError("name")}
          changed={entry?.name !== undefined}
          hint={entry?.name !== undefined ? t("import.review.wasName", { name: item.name }) : undefined}
          onCommit={(v) => onEdit("name", v)}
          onReset={() => onEdit("name", item.name)}
        />
        <ProjectCell
          id={`${rowKey}-project`}
          label={t("import.review.col.project")}
          value={entry?.project ?? ""}
          noneLabel={eff?.project ?? t("import.review.origin.default")}
          projects={projects}
          disabled={!included}
          error={fieldError("project")}
          changed={entry?.project !== undefined}
          onCommit={(v) => onEdit("project", v === "" ? undefined : v)}
          onReset={() => onEdit("project", undefined)}
        />
        <Cell
          id={`${rowKey}-env`}
          label={t("import.review.col.environment")}
          value={entry?.environment ?? ""}
          placeholder={eff?.environment ?? t("import.review.origin.default")}
          list="imp-environments"
          disabled={!included}
          check={optChk("environment")}
          error={fieldError("environment")}
          changed={entry?.environment !== undefined}
          onCommit={(v) => onEdit("environment", v)}
          onReset={() => onEdit("environment", undefined)}
        />
        {kind === "app" ? (
          <Cell
            id={`${rowKey}-alias`}
            label={t("import.review.col.alias")}
            value={aliasRaw}
            placeholder={t("import.review.aliasPlaceholder")}
            disabled={!included}
            check={aliasChk}
            error={fieldError("containerAlias")}
            changed={entry?.containerAlias !== undefined}
            onCommit={(v) => onEdit("containerAlias", v === "" ? undefined : v)}
            onReset={() => onEdit("containerAlias", undefined)}
          />
        ) : (
          <Cell
            id={`${rowKey}-dbident`}
            label={t("import.review.col.dbIdentifier")}
            value={dbIdent}
            placeholder={t("import.review.origin.source")}
            disabled={!included}
            check={dbIdentChk}
            error={fieldError("dbIdentifier")}
            changed={entry?.dbIdentifier !== undefined}
            onCommit={(v) => onEdit("dbIdentifier", v === "" ? undefined : v)}
            onReset={() => onEdit("dbIdentifier", undefined)}
          />
        )}
      </div>
      {conflicts.length > 0 && (
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {conflicts.map((c, i) => (
            <li key={i} style={{ fontSize: 11, color: c.level === "error" ? "var(--c-r)" : c.level === "warn" ? "var(--c-am)" : "var(--c-tx3)" }}>
              {t(`import.conflict.level.${c.level}`)}: {t(`import.conflict.${c.code}`, c.params)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
