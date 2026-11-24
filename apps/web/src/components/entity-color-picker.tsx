"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, Check } from "lucide-react";
import { useT } from "../i18n/provider";
import { PRESET_COLORS, normalizeHex } from "../lib/color";
import { Btn } from "./ui";
import { EntityBadge } from "./entity-identity";
import { fieldStyle } from "./form";

const PRESET_KEYS: Record<(typeof PRESET_COLORS)[number], string> = {
  "#e5484d": "red", "#f76b15": "orange", "#f5a623": "amber", "#46a758": "green", "#12a594": "teal",
  "#0091ff": "blue", "#3e63dd": "indigo", "#8e4ec6": "purple", "#d6409f": "pink", "#6e6e76": "gray",
};

/**
 * Colour chooser for a team / project: preset swatches, a clear-to-default option, a one-click suggestion
 * (from the uploaded icon) and, behind "More", a custom hex field with a live preview. The picker only
 * reports choices; the caller persists them. Selected state is shown with a check mark, not colour alone.
 */
export function EntityColorPicker({
  value, onChange, suggestion, onDismissSuggestion, disabled, previewLabel,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
  /** A colour taken from the freshly uploaded icon; rendered as a one-click "use it" row. */
  suggestion?: string | null;
  onDismissSuggestion?: () => void;
  disabled?: boolean;
  /** Text shown in the preview badge (the team / project name). */
  previewLabel: string;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value ?? "");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(value ?? ""); setInvalid(false); }, [value]);

  const commitDraft = () => {
    if (!draft.trim()) { setInvalid(false); return; }
    const hex = normalizeHex(draft);
    if (!hex) { setInvalid(true); return; }
    setInvalid(false);
    if (hex !== value) onChange(hex);
  };

  // Radio-group keyboard model: one tab stop (the selected swatch), arrows move + select, Home/End jump.
  const options: (string | null)[] = [null, ...PRESET_COLORS];
  const selectedIdx = options.findIndex((o) => o === value);
  const tabIdx = selectedIdx >= 0 ? selectedIdx : 0;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onSwatchKey = (e: React.KeyboardEvent, i: number) => {
    const n = options.length;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(options[next]);
  };

  const showSuggestion = !!suggestion && suggestion !== value;
  return (
    <div role="group" aria-label={t("identity.color")} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{t("identity.color")}</div>
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("identity.colorHint")}</div>
      </div>

      {showSuggestion && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)" }}>
          <span aria-hidden style={{ width: 22, height: 22, borderRadius: 6, background: suggestion!, border: "1px solid var(--c-bd)", flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 140, fontSize: 12.5, color: "var(--c-tx2)" }}>{t("identity.suggestion")}</span>
          <Btn onClick={() => onChange(suggestion!)} disabled={disabled}>{t("identity.suggestionUse", { hex: suggestion! })}</Btn>
          <Btn variant="ghost" onClick={onDismissSuggestion} disabled={disabled}>{t("identity.suggestionSkip")}</Btn>
        </div>
      )}

      <div role="radiogroup" aria-label={t("identity.color")} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          ref={(el) => { refs.current[0] = el; }}
          type="button" role="radio" aria-checked={value === null} disabled={disabled}
          tabIndex={tabIdx === 0 ? 0 : -1}
          onKeyDown={(e) => onSwatchKey(e, 0)}
          onClick={() => onChange(null)}
          style={{ ...swatchBase, background: "var(--c-tile)", color: "var(--c-tx2)", boxShadow: value === null ? ringShadow : undefined }}
        >
          {value === null ? <Check size={14} aria-hidden /> : null}
          <span style={srOnly}>{t("identity.colorDefault")}</span>
          {value !== null && <Ban size={14} aria-hidden />}
        </button>
        {PRESET_COLORS.map((hex, pi) => {
          const name = t(`identity.presets.${PRESET_KEYS[hex]}`);
          const selected = value === hex;
          return (
            <button
              key={hex} ref={(el) => { refs.current[pi + 1] = el; }}
              type="button" role="radio" aria-checked={selected} aria-label={t("identity.colorUse", { name })} title={name}
              tabIndex={tabIdx === pi + 1 ? 0 : -1} onKeyDown={(e) => onSwatchKey(e, pi + 1)}
              disabled={disabled} onClick={() => onChange(hex)}
              style={{ ...swatchBase, background: hex, boxShadow: selected ? ringShadow : undefined }}
            >
              {selected && <Check size={14} color="#fff" aria-hidden style={{ filter: "drop-shadow(0 0 1px rgba(0,0,0,.7))" }} />}
            </button>
          );
        })}
      </div>

      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--c-tx3)" }}>{t("identity.more")}</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--c-tx2)" }}>
            {t("identity.customHex")}
            <input
              value={draft} disabled={disabled} placeholder="#3e63dd" maxLength={7} spellCheck={false} autoComplete="off"
              aria-invalid={invalid || undefined} aria-describedby={invalid ? "identity-hex-error" : undefined}
              onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
              onBlur={commitDraft}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitDraft(); } }}
              style={{ ...fieldStyle, maxWidth: 160, fontFamily: "var(--font-mono, monospace)" }}
            />
          </label>
          {invalid && <div id="identity-hex-error" role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("identity.hexInvalid")}</div>}
          {value && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("identity.preview")}</span>
              <EntityBadge color={value}>{previewLabel}</EntityBadge>
              <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("identity.contrastNote")}</span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

const swatchBase: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 8, border: "1px solid var(--c-bd)", padding: 0, cursor: "pointer",
  display: "inline-flex", alignItems: "center", justifyContent: "center", outlineOffset: 3, position: "relative",
};

// Selected ring (a gap then a contrasting ring) so selection never relies on the swatch colour alone.
const ringShadow = "0 0 0 2px var(--c-bg), 0 0 0 4px var(--c-tx)";

const srOnly: React.CSSProperties = {
  position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap",
};
