"use client";

import { Children, cloneElement, isValidElement, useEffect, useId, type CSSProperties, type InputHTMLAttributes, type ReactElement, type Ref, type ReactNode, type TextareaHTMLAttributes } from "react";
import { useT } from "../i18n/provider";
import { Btn, SectionCard } from "./ui";

const monoStyle: CSSProperties = { fontFamily: "var(--font-mono, monospace)" };

/** Shared control styling (was duplicated inline as `field` across pages). */
export const fieldStyle: CSSProperties = {
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--c-tx2)",
  marginBottom: 5,
};

/** Labeled field wrapper — accessible (label htmlFor) + optional hint/error. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  style,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  // Link the label to the control and wire hint/error for screen readers. ONLY auto-wire (clone an id +
  // aria-describedby + aria-invalid onto the single child) when the caller did NOT name the control with
  // `htmlFor`. When `htmlFor` IS given, the caller owns the id on the real control
  // (`<Field htmlFor="x"><TextInput id="x"/></Field>`), and the single child may be a WRAPPER (e.g. a colour
  // swatch + input) — injecting the id there would land it on a non-labellable <div> and duplicate the id,
  // breaking the label→control association. So trust the caller's htmlFor and leave the children untouched.
  const autoId = useId();
  const controlId = htmlFor ?? `field-${autoId}`;
  const hintId = hint && !error ? `hint-${autoId}` : undefined;
  const errorId = error ? `err-${autoId}` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  const only = !htmlFor && Children.count(children) === 1 ? Children.toArray(children)[0] : null;
  const control =
    only && isValidElement(only)
      ? cloneElement(only as ReactElement<Record<string, unknown>>, {
          id: controlId,
          "aria-describedby": describedBy,
          ...(error ? { "aria-invalid": true } : {}),
        })
      : children;
  return (
    <div style={{ display: "flex", flexDirection: "column", ...style }}>
      <label htmlFor={controlId} style={labelStyle}>{label}</label>
      {control}
      {hint && !error && <span id={hintId} style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 4 }}>{hint}</span>}
      {error && <span id={errorId} role="alert" style={{ fontSize: 11, color: "var(--c-r)", marginTop: 4 }}>{error}</span>}
    </div>
  );
}

export function TextInput({
  mono,
  style,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; ref?: Ref<HTMLInputElement> }) {
  return <input {...rest} style={{ ...fieldStyle, ...(mono ? monoStyle : {}), ...style }} />;
}

/** Numeric input — a TextInput preset to type=number with a numeric mobile keypad. */
export function NumberInput({
  style,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="number" inputMode="numeric" {...rest} style={{ ...fieldStyle, ...style }} />;
}

/** Multi-line input. `mono` switches to the monospace face for code/config (env, labels, commands). */
export function Textarea({
  mono,
  style,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea {...rest} style={{ ...fieldStyle, resize: "vertical", ...(mono ? monoStyle : {}), ...style }} />;
}

/** Labeled checkbox — a real <input type=checkbox> tied to its <label> (was ad-hoc inline rows). */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const autoId = useId();
  const cid = id ?? `cb-${autoId}`;
  return (
    <label htmlFor={cid} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--c-tx2)", cursor: disabled ? "default" : "pointer" }}>
      <input id={cid} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export interface Option {
  value: string;
  label: string;
}

/**
 * Select with a proper disabled placeholder (fixes the old bug where the empty
 * option borrowed the first item's name → looked duplicated). `autoSelectFirst`
 * preselects the single sensible default (e.g. the only team) on mount.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  autoSelectFirst = false,
  required = false,
  id,
  ariaLabel,
  style,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  autoSelectFirst?: boolean;
  required?: boolean;
  id?: string;
  /** Accessible name when the select has no associated <label> (e.g. a placeholder-only select). */
  ariaLabel?: string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  useEffect(() => {
    if (autoSelectFirst && value === "" && options.length > 0) {
      onChange(options[0].value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSelectFirst, value, options.length]);

  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      required={required}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...fieldStyle, ...style }}
    >
      <option value="" disabled>{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** Stable id helper for Field/control pairing. */
export function useFieldId(prefix: string): string {
  return `${prefix}-${useId()}`;
}

/**
 * A card's action bar: optional left-aligned extras (e.g. an Add button), an "unsaved changes"
 * cue, then a right-aligned Save. Save is disabled while saving, while `disabled`, or — when the
 * card tracks it — while `dirty` is explicitly false; a card that doesn't pass `dirty` keeps Save
 * enabled. Replaces the three different mid-card save rows the config cards grew independently.
 */
export function FormActions({
  dirty,
  saving,
  onSave,
  saveLabel,
  disabled,
  children,
}: {
  dirty?: boolean;
  saving?: boolean;
  onSave: () => void;
  saveLabel?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {children}
      {dirty && !saving && <span style={{ fontSize: 12, color: "var(--c-am)" }}>{t("common.unsaved")}</span>}
      <div style={{ flex: 1 }} />
      <Btn onClick={onSave} disabled={disabled || saving || dirty === false}>
        {saving ? t("common.saving") : saveLabel ?? t("common.save")}
      </Btn>
    </div>
  );
}

/**
 * Consistent save feedback for config cards: the global mutation cache already toasts errors and
 * (via meta.successMessage) successes, so a card only needs to hand this meta to useMutation to get
 * the same toast everywhere — no more per-card onSuccess/onError toast wiring that drifted in style.
 */
export function useSaveFeedback(successKey = "common.saved") {
  const t = useT();
  return { meta: { successMessage: t(successKey) } };
}

/**
 * A SectionCard specialised for a config form: title/description header, body, and a built-in
 * FormActions footer (dirty-gated Save + optional left extras). Cards that need a bespoke footer
 * use SectionCard directly.
 */
export function ConfigCard({
  title,
  desc,
  right,
  dirty,
  saving,
  onSave,
  saveLabel,
  saveDisabled,
  actions,
  children,
}: {
  title?: string;
  desc?: string;
  right?: ReactNode;
  dirty?: boolean;
  saving?: boolean;
  onSave: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
  /** Left-aligned footer extras (e.g. an Add-row button). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SectionCard
      title={title}
      desc={desc}
      right={right}
      footer={
        <FormActions dirty={dirty} saving={saving} onSave={onSave} saveLabel={saveLabel} disabled={saveDisabled}>
          {actions}
        </FormActions>
      }
    >
      {children}
    </SectionCard>
  );
}
