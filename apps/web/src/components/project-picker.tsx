"use client";

import { useId, useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { validateName } from "../lib/import-mapping";
import { Btn } from "./ui";
import { fieldStyle } from "./form";

/** One project the picker offers. `name` is what is chosen; a project that does not exist yet is `isNew` (it is created when the work is applied). */
export interface ProjectChoice {
  name: string;
  isNew?: boolean;
}

const NEW = "::new-project::";
const control: CSSProperties = { ...fieldStyle, minHeight: 44, fontSize: 14 };

/** The existing projects of a team as picker choices (every project of the user's teams when no team is given). */
export function useProjectChoices(teamId?: string): ProjectChoice[] {
  const { data } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects(), retry: false });
  return useMemo(() => (data ?? []).filter((p) => !teamId || p.teamId === teamId).map((p) => ({ name: p.name })), [data, teamId]);
}

/**
 * The one project chooser: a dropdown of projects with "+ New project" at the top, which opens a small inline name field.
 * There is no free-text project input anywhere else. `onCreate` is optional: a screen that creates the project right away passes
 * it (the picker waits for it and keeps the choice only when it succeeds); a screen that creates projects later, when the work is
 * applied, omits it and the new name is simply chosen and listed as new.
 */
export function ProjectPicker({
  id,
  value,
  projects,
  onChange,
  onCreate,
  noneLabel,
  disabled,
  invalid,
  describedBy,
  ariaLabel,
  style,
}: {
  id?: string;
  /** The chosen project's name; "" is "no project chosen" (shown as `noneLabel`). */
  value: string;
  projects: ProjectChoice[];
  onChange: (name: string) => void;
  onCreate?: (name: string) => Promise<unknown> | void;
  /** The label of the empty choice (for example the project the source already puts it in). Without it there is no empty choice. */
  noneLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** For a picker without a visible <label>. */
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  const t = useT();
  const auto = useId();
  const sid = id ?? `pp-${auto}`;
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string[]>([]);

  const options = useMemo(() => {
    const byKey = new Map<string, ProjectChoice>();
    for (const p of projects) byKey.set(p.name.toLowerCase(), p);
    for (const n of made) if (!byKey.has(n.toLowerCase())) byKey.set(n.toLowerCase(), { name: n, isNew: true });
    if (value && !byKey.has(value.toLowerCase())) byKey.set(value.toLowerCase(), { name: value, isNew: true });
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, made, value]);

  const close = () => {
    setCreating(false);
    setDraft("");
    setError(null);
  };

  const create = async () => {
    const r = validateName("project", draft);
    if (!r.ok) return setError(t("pickers.project.invalid"));
    const name = r.value;
    const existing = options.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      onChange(existing.name);
      return close();
    }
    if (onCreate) {
      setBusy(true);
      try {
        await onCreate(name);
      } catch (e) {
        setBusy(false);
        return setError((e as Error).message || t("pickers.project.failed"));
      }
      setBusy(false);
    }
    setMade((m) => [...m, name]);
    onChange(name);
    close();
  };

  return (
    <div style={{ minWidth: 0 }}>
      <select
        id={sid}
        aria-label={ariaLabel}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          if (e.target.value === NEW) setCreating(true);
          else onChange(e.target.value);
        }}
        style={{ ...control, ...(invalid ? { borderColor: "var(--c-r)" } : {}), ...style }}
      >
        <option value={NEW}>{t("pickers.project.new")}</option>
        {noneLabel !== undefined && <option value="">{noneLabel}</option>}
        {noneLabel === undefined && value === "" && <option value="" disabled>{t("pickers.project.select")}</option>}
        {options.map((o) => (
          <option key={o.name} value={o.name}>{o.isNew ? t("pickers.project.willCreate", { name: o.name }) : o.name}</option>
        ))}
      </select>
      {creating && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start", marginTop: 6 }}>
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <input
              autoFocus
              aria-label={t("pickers.project.newName")}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${sid}-err` : undefined}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  close();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              maxLength={120}
              style={{ ...control, ...(error ? { borderColor: "var(--c-r)" } : {}) }}
            />
            {error && (
              <div id={`${sid}-err`} role="alert" style={{ fontSize: 11, color: "var(--c-r)", marginTop: 2 }}>{error}</div>
            )}
          </div>
          <Btn onClick={() => void create()} disabled={busy || draft.trim() === ""} style={{ minHeight: 44 }}>
            {busy ? t("pickers.project.creating") : t("pickers.project.create")}
          </Btn>
          <Btn variant="ghost" onClick={close} disabled={busy} style={{ minHeight: 44 }}>{t("pickers.project.cancel")}</Btn>
        </div>
      )}
    </div>
  );
}
