"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Template } from "../lib/types";
import type { InstalledInfo } from "../lib/installed";
import { badgeLabel } from "../lib/badges";
import { filterTemplates, presentCategories, groupByCategory } from "../lib/template-filter";
import { TemplateLogo } from "../lib/template-icons";
import { useT } from "../i18n/provider";
import { TextInput } from "./form";

const logoBox: React.CSSProperties = {
  // Theme-aware subtle fill (was a hardcoded white tint → invisible in light mode).
  width: 56, height: 56, borderRadius: 12, background: "color-mix(in srgb, var(--c-tx) 8%, transparent)",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  overflow: "hidden", padding: 8, boxSizing: "border-box",
};
const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 };
const sectionHeading: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, margin: "0 0 12px",
  fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--c-tx2)",
};
const openLink: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--c-a)", display: "inline-flex", alignItems: "center", gap: 3 };
const installedPill = (running: boolean): React.CSSProperties => ({
  fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, alignSelf: "flex-start", whiteSpace: "nowrap",
  color: running ? "var(--c-g)" : "var(--c-tx3)",
  background: running ? "color-mix(in srgb, var(--c-g) 15%, transparent)" : "color-mix(in srgb, var(--c-tx) 8%, transparent)",
});
const badgeChip: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, padding: "1px 7px", borderRadius: 999, whiteSpace: "nowrap",
  color: "var(--c-tx2)", background: "color-mix(in srgb, var(--c-tx) 8%, transparent)",
};

/**
 * Browseable app-store template gallery: free-text search + category chips +
 * icon cards. Shared by the New-resource wizard and the standalone /app-store
 * page; the caller decides what a card click does via onPick — or onDetails, when
 * supplied, which opens an app-detail sheet instead (the standalone store wires
 * this; the New-resource wizard leaves it off to keep its direct-pick behavior).
 * When `installed` is supplied (keyed by template slug), a card shows an
 * Installed/Running badge and, for a running install, an Open link — so the user
 * opens it instead of deploying a duplicate. A Featured shelf surfaces curated
 * apps at the top of the unfiltered view.
 */
export function TemplateGrid({
  templates,
  onPick,
  onDetails,
  installed,
}: {
  templates: Template[];
  onPick: (tpl: Template) => void;
  onDetails?: (tpl: Template) => void;
  installed?: Map<string, InstalledInfo>;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const matches = filterTemplates(templates, q, cat);
  const chips = ["all", ...presentCategories(templates)];
  // Browsing the full catalog with no search → group into category sections
  // (CasaOS-style, easier to scan). A search or a category chip → flat grid.
  const grouped = cat === "all" && q.trim() === "";
  const groups = grouped ? groupByCategory(templates) : [];
  // Curated Featured apps surface at the very top of the unfiltered view.
  const featured = grouped ? templates.filter((tpl) => tpl.featured) : [];

  const open = onDetails ?? onPick; // a card click opens the detail sheet when wired, else picks directly

  const renderTile = (tpl: Template) => {
    const inst = installed?.get(tpl.slug);
    return (
    <button
      key={tpl.slug}
      type="button"
      className="tpl-tile"
      onClick={() => open(tpl)}
      title={tpl.description}
      style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, textAlign: "left", padding: 12, borderRadius: "var(--r1)", cursor: "pointer", fontFamily: "inherit", background: "var(--c-el)", border: "1px solid var(--c-bd)", color: "var(--c-tx)", width: "100%" }}
    >
      <span style={logoBox}><TemplateLogo logo={tpl.logo} slug={tpl.slug} name={tpl.name} size={36} /></span>
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{tpl.name}</span>
        <span style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{tpl.tagline || tpl.description}</span>
        {tpl.badges && tpl.badges.length > 0 && (
          <span style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 2 }}>
            {tpl.badges.map((b) => (
              <span key={b} style={badgeChip}>{badgeLabel(t, b)}</span>
            ))}
          </span>
        )}
        {inst && (
          <span style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
            <span style={installedPill(inst.running)}>
              {inst.running ? t("resources.storeRunning") : t("resources.storeInstalled")}
              {inst.count > 1 ? ` ×${inst.count}` : ""}
            </span>
            {inst.url && (
              <a href={inst.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={openLink}>
                {t("resources.storeOpen")} <ExternalLink size={11} />
              </a>
            )}
          </span>
        )}
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
    );
  };

  return (
    <>
      <div style={{ maxWidth: 480, marginBottom: 10 }}>
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("resources.searchServices")} />
      </div>
      <div className="tpl-chips">
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
                flexShrink: 0, whiteSpace: "nowrap", // stay on one line inside the mobile scroll strip
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
      {grouped && featured.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <h2 style={sectionHeading}>
            {t("resources.featured")}
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--c-tx3)" }}>{featured.length}</span>
          </h2>
          <div style={grid3}>{featured.map(renderTile)}</div>
        </section>
      )}
      {grouped ? (
        groups.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("resources.noMatches")}</div>
        ) : (
          groups.map((g) => (
            <section key={g.category} style={{ marginBottom: 22 }}>
              <h2 style={sectionHeading}>
                {t(`resources.cat_${g.category}`)}
                <span style={{ fontSize: 11, fontWeight: 500, color: "var(--c-tx3)" }}>{g.items.length}</span>
              </h2>
              <div style={grid3}>{g.items.map(renderTile)}</div>
            </section>
          ))
        )
      ) : matches.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("resources.noMatches")}</div>
      ) : (
        <div style={grid3}>{matches.map(renderTile)}</div>
      )}
    </>
  );
}
