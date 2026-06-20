"use client";

import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { useT } from "../i18n/provider";
import { Btn, Card } from "./ui";

/** Client-side preview of the server-side normalizeTags (lowercase + hyphenate). */
function clean(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const chip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  padding: "3px 9px",
  borderRadius: 999,
  border: "1px solid var(--c-bd)",
  background: "var(--c-el)",
  color: "var(--c-tx2)",
};

/** Read-only inline tag chips, e.g. on a list row. */
export function TagChips({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      {tags.map((t) => (
        <span key={t} style={{ ...chip, fontSize: 11, padding: "1px 7px" }}>
          {t}
        </span>
      ))}
    </span>
  );
}

/** Toggle-chip bar for filtering a list by tag (AND semantics). */
export function TagFilter({
  all,
  selected,
  onChange,
}: {
  all: string[];
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  const t = useT();
  if (!all.length) return null;
  const toggle = (tag: string) =>
    onChange(selected.includes(tag) ? selected.filter((x) => x !== tag) : [...selected, tag]);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
      <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("tags.filter")}:</span>
      {all.map((tag) => {
        const on = selected.includes(tag);
        return (
          <button
            key={tag}
            onClick={() => toggle(tag)}
            style={{
              ...chip,
              cursor: "pointer",
              fontFamily: "inherit",
              background: on ? "var(--c-a)" : "var(--c-el)",
              color: on ? "#0d0d11" : "var(--c-tx2)",
              borderColor: on ? "var(--c-a)" : "var(--c-bd)",
              fontWeight: on ? 700 : 400,
            }}
          >
            {tag}
          </button>
        );
      })}
      {selected.length > 0 && (
        <button
          onClick={() => onChange([])}
          style={{ background: "transparent", border: "none", color: "var(--c-lapis)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
        >
          {t("tags.clear")}
        </button>
      )}
    </div>
  );
}

/** Editable tag list inside a detail-page card: add via Enter/comma, remove via ×, Save. */
export function TagsCard({
  tags,
  canWrite,
  onSave,
}: {
  tags: string[];
  canWrite: boolean;
  onSave: (tags: string[]) => void;
}) {
  const t = useT();
  const [value, setValue] = useState<string[]>(tags);
  const [input, setInput] = useState("");
  const dirty = value.join(",") !== tags.join(",");

  const add = () => {
    const c = clean(input);
    if (c && !value.includes(c)) setValue([...value, c].slice(0, 20));
    setInput("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    }
  };

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("tags.title")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("tags.desc")}</p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {value.length === 0 && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("tags.none")}</span>}
        {value.map((tag) => (
          <span key={tag} style={chip}>
            {tag}
            {canWrite && (
              <button
                onClick={() => setValue(value.filter((x) => x !== tag))}
                style={{ background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", padding: 0, fontFamily: "inherit", fontSize: 13 }}
                aria-label={`remove ${tag}`}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {canWrite && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={t("tags.placeholder")}
            style={{
              flex: 1,
              minWidth: 160,
              fontFamily: "inherit",
              fontSize: 13,
              padding: "8px 10px",
              borderRadius: "var(--r1)",
              border: "1px solid var(--c-bd)",
              background: "var(--c-bg)",
              color: "var(--c-tx)",
            }}
          />
          <Btn variant="ghost" onClick={add} disabled={!clean(input)}>{t("tags.add")}</Btn>
          <Btn onClick={() => onSave(value)} disabled={!dirty}>{t("tags.save")}</Btn>
        </div>
      )}
    </Card>
  );
}
