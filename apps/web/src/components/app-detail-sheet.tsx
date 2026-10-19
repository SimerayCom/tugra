"use client";

import { ExternalLink } from "lucide-react";
import type { Template } from "../lib/types";
import type { InstalledInfo } from "../lib/installed";
import { badgeLabel } from "../lib/badges";
import { TemplateLogo } from "../lib/template-icons";
import { useT } from "../i18n/provider";
import { Modal } from "./modal";
import { Btn } from "./ui";

const badgeChip: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 999,
  color: "var(--c-tx2)", background: "color-mix(in srgb, var(--c-tx) 8%, transparent)", whiteSpace: "nowrap",
};

/**
 * App-store detail sheet: what an app is + what it needs, before installing. Shows the logo, tagline, full
 * description, capability badges and a docs link, with an Install button that hands off to the page's existing
 * install flow. Opened from a store card (the New-resource wizard keeps its direct-pick behavior by not wiring
 * onDetails). Pure presentation — no fetch.
 */
export function AppDetailSheet({
  template,
  installed,
  onInstall,
  onClose,
}: {
  template: Template;
  installed?: InstalledInfo;
  onInstall: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal onClose={onClose} width={520} labelledBy="app-detail-name">
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
        <span style={{ width: 52, height: 52, borderRadius: 12, background: "color-mix(in srgb, var(--c-tx) 8%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden", padding: 8, boxSizing: "border-box" }}>
          <TemplateLogo logo={template.logo} slug={template.slug} name={template.name} size={34} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h2 id="app-detail-name" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{template.name}</h2>
          {template.tagline && <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "2px 0 0" }}>{template.tagline}</p>}
        </div>
      </div>

      {(template.badges?.length || installed) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {installed && (
            <span style={{ ...badgeChip, color: installed.running ? "var(--c-g)" : "var(--c-tx3)", background: installed.running ? "color-mix(in srgb, var(--c-g) 15%, transparent)" : badgeChip.background as string }}>
              {installed.running ? t("resources.storeRunning") : t("resources.storeInstalled")}
            </span>
          )}
          {template.badges?.map((b) => (
            <span key={b} style={badgeChip}>{badgeLabel(t, b)}</span>
          ))}
        </div>
      )}

      <p style={{ fontSize: 14, color: "var(--c-tx3)", lineHeight: 1.5, margin: "0 0 16px" }}>{template.description}</p>

      {/* Action row BEFORE the docs link so the modal's initial focus lands on Install (the primary action),
          not on an external link that would navigate away on Enter. */}
      <div style={{ display: "flex", gap: 10 }}>
        <Btn onClick={onInstall} style={{ flex: 1 }}>{installed ? t("resources.storeInstallAnother") : t("resources.storeInstall")}</Btn>
        <Btn variant="ghost" onClick={onClose}>{t("resources.storeCancel")}</Btn>
      </div>

      {template.documentation && (
        <a href={template.documentation} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: "var(--c-a)", display: "inline-flex", alignItems: "center", gap: 4, marginTop: 14 }}>
          {t("resources.docTitle")} <ExternalLink size={13} />
        </a>
      )}
    </Modal>
  );
}
