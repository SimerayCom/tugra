"use client";

import { FilePen, FolderOpen, Terminal, Waypoints, type LucideIcon } from "lucide-react";
import { useT } from "../i18n/provider";

/** The opt-in capabilities worth showing at a glance (the same four the bulk grant dialog offers). */
export const ACCESS_BADGES: { cap: string; icon: LucideIcon }[] = [
  { cap: "terminal", icon: Terminal },
  { cap: "files", icon: FolderOpen },
  { cap: "files_write", icon: FilePen },
  { cap: "swarm", icon: Waypoints },
];

/**
 * Per-server access badges: a coloured icon when the capability is granted, a grey struck-through icon when it is
 * off. State is carried by the icon treatment AND the accessible name/tooltip ("Terminal on" / "Terminal off"),
 * never by colour alone. Presentational; granting happens in the bulk dialog or the server's Capabilities card.
 */
export function CapabilityBadges({ capabilities }: { capabilities: readonly string[] | undefined }) {
  const t = useT();
  const granted = new Set(capabilities ?? []);
  return (
    <ul aria-label={t("servers.accessColumn")} style={{ display: "inline-flex", alignItems: "center", gap: 6, listStyle: "none", margin: 0, padding: 0 }}>
      {ACCESS_BADGES.map(({ cap, icon: Icon }) => {
        const on = granted.has(cap);
        const label = t(on ? "servers.capOn" : "servers.capOff", { name: t(`servers.capShort_${cap}`) });
        return (
          <li key={cap} data-cap={cap} data-on={on ? "true" : "false"} data-tip={on ? label : t("servers.capOffHint", { name: t(`servers.capShort_${cap}`) })} tabIndex={0} style={{ display: "inline-flex", position: "relative", width: 20, height: 20, alignItems: "center", justifyContent: "center", color: on ? "var(--c-a)" : "var(--c-tx3)", opacity: on ? 1 : 0.55 }}>
            <Icon size={15} aria-hidden="true" />
            {!on && <span aria-hidden="true" style={{ position: "absolute", left: 2, right: 2, top: "50%", height: 1.5, background: "currentColor", transform: "rotate(-45deg)" }} />}
            <span className="sr-only">{label}</span>
          </li>
        );
      })}
    </ul>
  );
}
