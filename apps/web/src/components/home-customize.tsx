"use client";

import { Plus, X } from "lucide-react";
import { useT } from "../i18n/provider";
import { Btn, Card } from "./ui";
import { Checkbox, Select, TextInput } from "./form";
import { GROUP_MODES, WALLPAPERS, WIDGETS, WALLPAPER_CSS, type GroupMode, type HomeLayout, type Wallpaper, type WidgetId } from "../lib/home-layout";
import type { HomeFolder } from "../lib/home-mode";

const sectionLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", marginBottom: 6 };

/** Editing panel for the Home layout: grouping, wallpaper, widgets and folders. Stateless; the page owns the layout. */
export function HomeCustomizePanel({ layout, onChange }: { layout: HomeLayout; onChange: (patch: Partial<HomeLayout>) => void }) {
  const t = useT();
  const setFolders = (folders: HomeFolder[]) => onChange({ folders });
  const addFolder = () => {
    const id = `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setFolders([...layout.folders, { id, name: t("home.folderNameDefault", { n: layout.folders.length + 1 }), tileIds: [] }]);
  };
  return (
    <Card style={{ padding: 16, marginBottom: 20, display: "grid", gap: 16 }}>
      <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("home.customizeHint")}</div>

      <div>
        <div style={sectionLabel}>{t("home.groupBy")}</div>
        <Select
          value={layout.groupMode}
          onChange={(v) => onChange({ groupMode: v as GroupMode })}
          ariaLabel={t("home.groupBy")}
          options={GROUP_MODES.map((m) => ({ value: m, label: t(`home.group_${m}`) }))}
          style={{ maxWidth: 280 }}
        />
      </div>

      <div role="radiogroup" aria-label={t("home.wallpaper")}>
        <div style={sectionLabel}>{t("home.wallpaper")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {WALLPAPERS.map((w: Wallpaper) => {
            const active = layout.wallpaper === w;
            return (
              <button
                key={w}
                role="radio"
                aria-checked={active}
                onClick={() => onChange({ wallpaper: w })}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                  color: "var(--c-tx)", background: "var(--c-el)", borderRadius: "var(--r1)",
                  border: `1px solid ${active ? "var(--c-a)" : "var(--c-bd)"}`,
                }}
              >
                <span aria-hidden style={{ width: 18, height: 18, borderRadius: 5, border: "1px solid var(--c-bd)", background: WALLPAPER_CSS[w] ?? "var(--c-bg)" }} />
                {t(`home.wallpaper_${w}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div role="group" aria-label={t("home.widgets")}>
        <div style={sectionLabel}>{t("home.widgets")}</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {WIDGETS.map((w: WidgetId) => (
            <Checkbox
              key={w}
              checked={layout.widgets[w]}
              onChange={(on) => onChange({ widgets: { ...layout.widgets, [w]: on } })}
              label={t(`home.widget${w[0].toUpperCase()}${w.slice(1)}`)}
            />
          ))}
        </div>
      </div>

      <div>
        <div style={sectionLabel}>{t("home.folder")}</div>
        <div style={{ display: "grid", gap: 8 }}>
          {layout.folders.map((f) => (
            <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "center", maxWidth: 360 }}>
              <TextInput
                value={f.name}
                maxLength={60}
                aria-label={t("home.folderName")}
                onChange={(e) => setFolders(layout.folders.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x)))}
              />
              <button
                onClick={() => setFolders(layout.folders.filter((x) => x.id !== f.id))}
                aria-label={t("home.folderRemove", { name: f.name })}
                title={t("home.folderRemove", { name: f.name })}
                style={{ display: "inline-flex", width: 30, height: 30, alignItems: "center", justifyContent: "center", flexShrink: 0, background: "transparent", border: "none", cursor: "pointer", color: "var(--c-tx3)" }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
          <div>
            <Btn variant="ghost" icon={Plus} onClick={addFolder}>{t("home.addFolder")}</Btn>
          </div>
        </div>
      </div>
    </Card>
  );
}
