"use client";

import { useMemo, useState } from "react";
import { RESOURCE_ICON_KEYS } from "@tugra/shared/dist/resource-icons";
import { useT } from "../i18n/provider";
import { TemplateLogo } from "../lib/template-icons";

/** The icon keys whose name contains every word of `query` (case-insensitive); all keys for an empty query. */
export function filterIconKeys(query: string, keys: readonly string[] = RESOURCE_ICON_KEYS): string[] {
  const words = query.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return [...keys];
  return keys.filter((k) => words.every((w) => k.includes(w)));
}

const tile = (active: boolean, disabled?: boolean): React.CSSProperties => ({
  width: 40,
  height: 40,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  borderRadius: "var(--r1)",
  border: active ? "2px solid var(--c-a)" : "1px solid var(--c-bd)",
  background: "var(--c-el)",
  cursor: disabled ? "default" : "pointer",
  opacity: disabled ? 0.6 : 1,
});

/**
 * Pick a brand icon from the shared set for one resource. "Automatic" is listed first and is the value when
 * nothing is picked (the icon then comes from the image or the site). The grid has a fixed height and scrolls;
 * logos load lazily, so opening it does not fetch the whole set at once.
 */
export function IconKeyPicker({
  value,
  onChange,
  disabled,
  hasUpload,
}: {
  value: string | null;
  onChange: (key: string | null) => void;
  disabled?: boolean;
  /** An uploaded icon exists: say that picking one replaces it. */
  hasUpload?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const keys = useMemo(() => filterIconKeys(query), [query]);
  const automaticActive = value === null && !hasUpload;
  // Closed by default: the 280-odd logos are only mounted (and fetched) once the user asks for them.
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} aria-expanded={false} style={{ minHeight: 32, padding: "4px 12px", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", background: "var(--c-el)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>
        {t("pickers.icon.choose")}
      </button>
    );
  }
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={disabled || (value === null)}
          aria-pressed={automaticActive}
          style={{ minHeight: 32, padding: "4px 12px", borderRadius: "var(--r1)", border: automaticActive ? "2px solid var(--c-a)" : "1px solid var(--c-bd)", background: "var(--c-el)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit", cursor: disabled || value === null ? "default" : "pointer" }}
        >
          {t("pickers.icon.automatic")}
        </button>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("pickers.icon.search")}
          aria-label={t("pickers.icon.search")}
          disabled={disabled}
          style={{ flex: 1, minWidth: 140, boxSizing: "border-box", padding: "6px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit" }}
        />
        <button type="button" onClick={() => setOpen(false)} aria-expanded style={{ minHeight: 32, padding: "4px 12px", borderRadius: "var(--r1)", border: "1px solid var(--c-bd)", background: "transparent", color: "var(--c-tx2)", fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>
          {t("pickers.icon.hide")}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 8 }}>
        {t("pickers.icon.automaticHint")}
        {hasUpload ? ` ${t("pickers.icon.replacesUpload")}` : ""}
      </div>
      {/* Fixed height: the grid never pushes the page around as logos arrive or the filter narrows. */}
      <div role="group" aria-label={t("pickers.icon.title")} style={{ height: 184, overflowY: "auto", display: "flex", flexWrap: "wrap", gap: 6, alignContent: "flex-start", padding: 2 }}>
        {keys.length === 0 && <div style={{ fontSize: 13, color: "var(--c-tx3)", padding: 6 }}>{t("pickers.icon.empty")}</div>}
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onChange(k)}
            disabled={disabled}
            aria-pressed={value === k}
            aria-label={t("pickers.icon.use", { name: k })}
            title={k}
            style={tile(value === k, disabled)}
          >
            <TemplateLogo slug={k} name={k} size={24} />
          </button>
        ))}
      </div>
    </div>
  );
}
