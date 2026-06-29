"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Template } from "../lib/types";
import { filterTemplates, presentCategories } from "../lib/template-filter";
import { TemplateLogo } from "../lib/template-icons";
import { useT } from "../i18n/provider";
import { TextInput } from "./form";

const logoBox: React.CSSProperties = {
  width: 52, height: 52, borderRadius: 10, background: "rgba(255,255,255,0.06)",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  overflow: "hidden", padding: 8, boxSizing: "border-box",
};
const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 };

/**
 * Browseable app-store template gallery: free-text search + category chips +
 * icon cards. Shared by the New-resource wizard and the standalone /app-store
 * page; the caller decides what a card click does via onPick.
 */
export function TemplateGrid({ templates, onPick }: { templates: Template[]; onPick: (tpl: Template) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const matches = filterTemplates(templates, q, cat);
  const chips = ["all", ...presentCategories(templates)];

  return (
    <>
      <div style={{ maxWidth: 480, marginBottom: 10 }}>
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("resources.searchServices")} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {chips.map((c) => {
          const active = c === cat;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              style={{
                fontFamily: "inherit", fontSize: 12, fontWeight: active ? 600 : 500,
                padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                border: "1px solid var(--c-bd)",
                background: active ? "var(--c-a)" : "transparent",
                color: active ? "#0d0d11" : "var(--c-tx3)",
              }}
            >
              {c === "all" ? t("resources.allCategories") : t(`resources.cat_${c}`)}
            </button>
          );
        })}
      </div>
      {matches.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("resources.noMatches")}</div>
      ) : (
        <div style={grid3}>
          {matches.map((tpl) => (
            <button
              key={tpl.slug}
              type="button"
              onClick={() => onPick(tpl)}
              title={tpl.description}
              style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, textAlign: "left", padding: 12, borderRadius: "var(--r1)", cursor: "pointer", fontFamily: "inherit", background: "var(--c-el)", border: "1px solid var(--c-bd)", color: "var(--c-tx)", width: "100%" }}
            >
              <span style={logoBox}><TemplateLogo logo={tpl.logo} slug={tpl.slug} name={tpl.name} size={36} /></span>
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{tpl.name}</span>
                <span style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{tpl.description}</span>
              </span>
              {tpl.documentation && (
                <a
                  href={tpl.documentation}
                  target="_blank"
                  rel="noreferrer"
                  title={t("resources.docTitle")}
                  aria-label={t("resources.docTitle")}
                  onClick={(e) => e.stopPropagation()}
                  style={{ position: "absolute", top: 8, right: 8, display: "inline-flex", padding: 3, borderRadius: 6, color: "var(--c-tx3)" }}
                >
                  <ExternalLink size={14} />
                </a>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
