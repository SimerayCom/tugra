"use client";

import React from "react";
import { useT } from "../../../i18n/provider";
import { Card } from "../../../components/ui";
import {
  CHART_TIMES,
  NAV_STYLES,
  PAGE_WIDTHS,
  THEMES,
  UI_SCALES,
  UI_STYLES,
  useAppearance,
  type ChartTimes,
  type NavStyle,
  type PageWidth,
  type ThemeChoice,
  type UiScale,
  type UiStyle,
} from "../../../lib/appearance";
import { CUSTOM_PRESETS } from "../../../lib/theme-custom";

/** One preference: a label, a hint and a wrapping row of mutually-exclusive options (a radio group). */
function OptionGroup<T extends string>({
  id,
  label,
  hint,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ padding: "14px 0", borderTop: "1px solid var(--c-bd)" }}>
      <div id={`ap-${id}`} style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
      {hint && <div style={{ fontSize: 12, color: "var(--c-tx3)", margin: "2px 0 0" }}>{hint}</div>}
      <div role="radiogroup" aria-labelledby={`ap-${id}`} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => { if (!active) onChange(o.value); }}
              style={{
                flex: "1 1 96px",
                minHeight: 38,
                padding: "8px 12px",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: active ? "default" : "pointer",
                color: active ? "var(--c-tx)" : "var(--c-tx2)",
                background: active ? "var(--c-ad)" : "var(--c-el)",
                border: `1px solid ${active ? "var(--c-a)" : "var(--c-bd)"}`,
                borderRadius: "var(--r1)",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Per-user look & feel (browser-local, no server round-trip): colour theme (light / system / dark / custom with
 * presets + accent and surface-tint pickers), UI scale, page width, navigation style, 3D/flat style and chart
 * time display. All state lives in useAppearance(), which persists to localStorage and applies it to <html>.
 */
export function AppearanceCard() {
  const t = useT();
  const ap = useAppearance();

  const themeLabel: Record<ThemeChoice, string> = {
    light: t("settings.appearanceThemeLight"),
    system: t("settings.appearanceThemeSystem"),
    dark: t("settings.appearanceThemeDark"),
    custom: t("settings.appearanceThemeCustom"),
  };
  const presetLabel: Record<string, string> = {
    gold: t("settings.appearancePresetGold"),
    slate: t("settings.appearancePresetSlate"),
    forest: t("settings.appearancePresetForest"),
    rose: t("settings.appearancePresetRose"),
  };
  const colorInput: React.CSSProperties = { width: 44, height: 34, padding: 2, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", cursor: "pointer" };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600 }}>{t("settings.appearance")}</div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("settings.appearanceDesc")}</div>

      <OptionGroup<ThemeChoice>
        id="theme"
        label={t("settings.appearanceTheme")}
        hint={t("settings.appearanceThemeHint")}
        value={ap.theme}
        options={THEMES.map((v) => ({ value: v, label: themeLabel[v] }))}
        onChange={ap.setTheme}
      />

      {ap.theme === "custom" && (
        <div data-testid="appearance-custom" style={{ padding: "0 0 14px" }}>
          <div id="ap-presets" style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", marginBottom: 8 }}>{t("settings.appearancePresets")}</div>
          <div role="radiogroup" aria-labelledby="ap-presets" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {CUSTOM_PRESETS.map((p) => {
              const active = ap.custom.preset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => ap.applyPreset(p.id)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 8, minHeight: 36, padding: "6px 12px",
                    fontFamily: "inherit", fontSize: 13, cursor: "pointer", color: "var(--c-tx)",
                    background: active ? "var(--c-ad)" : "var(--c-el)",
                    border: `1px solid ${active ? "var(--c-a)" : "var(--c-bd)"}`, borderRadius: "var(--r1)",
                  }}
                >
                  <span aria-hidden style={{ display: "inline-flex", borderRadius: 999, overflow: "hidden", border: "1px solid var(--c-bd)" }}>
                    <span style={{ width: 14, height: 14, background: p.tint }} />
                    <span style={{ width: 14, height: 14, background: p.accent }} />
                  </span>
                  {presetLabel[p.id]}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
              <input type="color" aria-label={t("settings.appearanceAccent")} value={ap.custom.accent} onChange={(e) => ap.setCustom({ accent: e.target.value })} style={colorInput} />
              <span>
                {t("settings.appearanceAccent")}
                <span className="mono" style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{ap.custom.accent}</span>
              </span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
              <input type="color" aria-label={t("settings.appearanceTint")} value={ap.custom.tint} onChange={(e) => ap.setCustom({ tint: e.target.value })} style={colorInput} />
              <span>
                {t("settings.appearanceTint")}
                <span className="mono" style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>{ap.custom.tint}</span>
              </span>
            </label>
          </div>
        </div>
      )}

      <OptionGroup<UiScale>
        id="scale"
        label={t("settings.appearanceScale")}
        hint={t("settings.appearanceScaleHint")}
        value={ap.uiScale}
        options={UI_SCALES.map((v) => ({ value: v, label: `${v}%` }))}
        onChange={ap.setUiScale}
      />

      <OptionGroup<PageWidth>
        id="width"
        label={t("settings.appearanceWidth")}
        hint={t("settings.appearanceWidthHint")}
        value={ap.pageWidth}
        options={PAGE_WIDTHS.map((v) => ({ value: v, label: v === "full" ? t("settings.appearanceWidthFull") : t("settings.appearanceWidthCentered") }))}
        onChange={ap.setPageWidth}
      />

      <OptionGroup<NavStyle>
        id="nav"
        label={t("settings.appearanceNav")}
        hint={t("settings.appearanceNavHint")}
        value={ap.navStyle}
        options={NAV_STYLES.map((v) => ({ value: v, label: v === "default" ? t("settings.appearanceNavDefault") : t("settings.appearanceNavFloating") }))}
        onChange={ap.setNavStyle}
      />

      <OptionGroup<UiStyle>
        id="style"
        label={t("settings.appearanceStyle")}
        hint={t("settings.appearanceStyleHint")}
        value={ap.uiStyle}
        options={UI_STYLES.map((v) => ({ value: v, label: v === "3d" ? t("settings.appearanceStyle3d") : t("settings.appearanceStyleFlat") }))}
        onChange={ap.setUiStyle}
      />

      <OptionGroup<ChartTimes>
        id="times"
        label={t("settings.appearanceChartTimes")}
        hint={t("settings.appearanceChartTimesHint")}
        value={ap.chartTimes}
        options={CHART_TIMES.map((v) => ({ value: v, label: v === "local" ? t("settings.appearanceTimesLocal") : t("settings.appearanceTimesLocalUtc") }))}
        onChange={ap.setChartTimes}
      />
    </Card>
  );
}
