"use client";

import { useId, type CSSProperties, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { useT } from "../i18n/provider";
import { copyText } from "../lib/clipboard";
import { useToast } from "./toast";
import { fieldStyle } from "./form";

/**
 * The one typed-confirmation input: the text the owner must type (a server name, an op id, a file name…) is the
 * input's placeholder, and a copy button sits next to the label that names it, so the owner can paste it instead of
 * retyping a long name. It stays a plain controlled input: the caller keeps the value and decides when it matches
 * (`typedMatches`) and gates its own confirm button on that.
 */
export function TypedConfirmField({
  expected,
  value,
  onChange,
  label,
  hint,
  id,
  onEnter,
  autoFocus,
  disabled,
  mono,
  style,
  testId,
}: {
  /** What must be typed; also the placeholder and what the copy button copies. */
  expected: string;
  value: string;
  onChange: (v: string) => void;
  /** The visible label, e.g. "Type my-server to confirm". It names the input for assistive tech too. */
  label: string;
  /** Optional line under the label (why the name is asked). */
  hint?: ReactNode;
  id?: string;
  /** Enter in the box; the caller guards it with its own "matches" check. */
  onEnter?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  mono?: boolean;
  style?: CSSProperties;
  testId?: string;
}) {
  const t = useT();
  const toast = useToast();
  const auto = useId();
  const inputId = id ?? `typed-${auto}`;
  return (
    <div style={{ display: "block", marginBottom: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginBottom: hint ? 2 : 4 }}>
        <label htmlFor={inputId} style={{ fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5, wordBreak: "break-word", flex: "1 1 auto", minWidth: 0 }}>
          {label}
        </label>
        <button
          type="button"
          data-testid={testId ? `${testId}-copy` : undefined}
          aria-label={t("common.copy")}
          title={t("common.copy")}
          onClick={async () => {
            const ok = await copyText(expected);
            toast(ok ? t("common.copied") : t("common.copyFailed"), ok ? "success" : "error");
          }}
          style={{ minWidth: 44, minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", borderRadius: "var(--r1)", flexShrink: 0 }}
        >
          <Copy size={14} aria-hidden />
        </button>
      </div>
      {hint && <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{hint}</p>}
      <input
        id={inputId}
        data-testid={testId}
        autoFocus={autoFocus}
        disabled={disabled}
        value={value}
        placeholder={expected}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEnter ? (e) => { if (e.key === "Enter") onEnter(); } : undefined}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className={mono ? "mono" : undefined}
        style={{ ...fieldStyle, minHeight: 44, ...style }}
      />
    </div>
  );
}

/** A typed confirmation matches only when the typed text equals the expected text exactly (the hub compares exactly too). */
export function typedMatches(typed: string, expected: string): boolean {
  return expected.length > 0 && typed === expected;
}
