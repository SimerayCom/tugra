"use client";

import { useEffect, useId, type CSSProperties, type ReactNode } from "react";

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
  return (
    <div style={{ display: "flex", flexDirection: "column", ...style }}>
      <label htmlFor={htmlFor} style={labelStyle}>{label}</label>
      {children}
      {hint && !error && <span style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 4 }}>{hint}</span>}
      {error && <span style={{ fontSize: 11, color: "var(--c-r)", marginTop: 4 }}>{error}</span>}
    </div>
  );
}

export function TextInput({
  style,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} style={{ ...fieldStyle, ...style }} />;
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
