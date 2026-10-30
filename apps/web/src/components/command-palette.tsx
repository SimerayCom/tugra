"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { useTeamScope } from "./team-scope";
import { useIsMobile } from "../hooks/useIsMobile";
import { Modal } from "./modal";
import {
  buildResourceItems,
  flatten,
  highlightParts,
  searchPalette,
  type PaletteGroup,
  type PaletteItem,
} from "../lib/command-search";

export interface CommandDest {
  labelKey: string;
  href: string;
}

const GROUP_LABEL_KEY: Record<PaletteGroup, string> = {
  actions: "nav.paletteActions",
  navigate: "nav.paletteNavigate",
  apps: "nav.paletteApps",
  databases: "nav.paletteDatabases",
  servers: "nav.paletteServers",
  domains: "nav.paletteDomains",
};
// Quick "create" actions — hrefs identical to the New menu.
const QUICK_ACTIONS: { labelKey: string; href: string }[] = [
  { labelKey: "nav.newResource", href: "/resources/new" },
  { labelKey: "nav.newProject", href: "/projects/new" },
  { labelKey: "nav.newServer", href: "/servers/new" },
];
const srOnly: React.CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" };
const statusColor = (s?: string): string | null =>
  !s ? null : s === "RUNNING" || s === "ONLINE" ? "var(--c-g)" : s === "FAILED" || s === "OFFLINE" ? "var(--c-r)" : "var(--c-am)";

/**
 * ⌘K command palette: fuzzy search over quick actions, nav destinations, and (fleet mode) live apps,
 * databases, servers and domains. Resources are fetched only while open. Full keyboard nav + ARIA combobox.
 */
export function CommandPalette({
  dests,
  onClose,
  fleet = true,
}: {
  dests: CommandDest[];
  onClose: () => void;
  fleet?: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const { teamId } = useTeamScope();
  const isMobile = useIsMobile();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const byKeyboard = useRef(false);

  const opts = { enabled: fleet, staleTime: 30_000, refetchOnWindowFocus: false } as const;
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps(), ...opts });
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers(), ...opts });
  const databases = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases(), ...opts });
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => api.listDomains(), ...opts });
  const loading = fleet && (apps.isLoading || servers.isLoading || databases.isLoading || domains.isLoading);

  const items = useMemo<PaletteItem[]>(() => {
    const actionHrefs = new Set(fleet ? QUICK_ACTIONS.map((a) => a.href) : []);
    const actionItems: PaletteItem[] = fleet ? QUICK_ACTIONS.map((a) => ({ id: "act:" + a.href, group: "actions", label: t(a.labelKey), href: a.href })) : [];
    // Drop a nav dest that a quick action already covers (e.g. Add Server == New Server → /servers/new).
    const navItems: PaletteItem[] = dests
      .filter((d) => !actionHrefs.has(d.href))
      .map((d) => ({ id: "nav:" + d.href, group: "navigate", label: t(d.labelKey), href: d.href }));
    const resourceItems = fleet
      ? buildResourceItems({ apps: apps.data ?? [], servers: servers.data ?? [], databases: databases.data ?? [], domains: domains.data ?? [] }, teamId)
      : [];
    return [...actionItems, ...navItems, ...resourceItems];
  }, [dests, fleet, t, teamId, apps.data, servers.data, databases.data, domains.data]);

  const groups = useMemo(() => searchPalette(items, q), [items, q]);
  const flat = flatten(groups);
  const activeItem = flat[Math.min(active, flat.length - 1)];

  // Scroll the active row into view only after a keyboard move (so mouse hover doesn't fight scrolling).
  useEffect(() => {
    if (!byKeyboard.current || !activeItem) return;
    document.getElementById(`cp-opt-${activeItem.item.id}`)?.scrollIntoView({ block: "nearest" });
    byKeyboard.current = false;
  }, [active, activeItem]);

  const go = (href: string) => { onClose(); router.push(href); };

  return (
    <Modal
      onClose={onClose}
      width={520}
      zIndex={9000}
      ariaLabel={t("nav.search")}
      backdropStyle={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", alignItems: "flex-start", paddingTop: isMobile ? "8vh" : "12vh" }}
      cardStyle={{ padding: 0, overflow: "hidden", maxWidth: "90vw", background: "var(--c-sb)", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
    >
      <input
        autoFocus
        value={q}
        role="combobox"
        aria-expanded
        aria-controls="cp-list"
        aria-autocomplete="list"
        aria-activedescendant={activeItem ? `cp-opt-${activeItem.item.id}` : undefined}
        onChange={(e) => { setQ(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (!flat.length) { if (e.key === "Enter") e.preventDefault(); return; }
          const len = flat.length;
          if (e.key === "ArrowDown") { e.preventDefault(); byKeyboard.current = true; setActive((i) => (i + 1) % len); }
          else if (e.key === "ArrowUp") { e.preventDefault(); byKeyboard.current = true; setActive((i) => (i - 1 + len) % len); }
          else if (e.key === "Home") { e.preventDefault(); byKeyboard.current = true; setActive(0); }
          else if (e.key === "End") { e.preventDefault(); byKeyboard.current = true; setActive(len - 1); }
          else if (e.key === "Enter") { e.preventDefault(); if (activeItem) go(activeItem.item.href); }
        }}
        placeholder={t("nav.search")}
        aria-label={t("nav.search")}
        style={{ width: "100%", padding: "14px 16px", background: "transparent", border: "none", borderBottom: "1px solid var(--c-bd)", color: "var(--c-tx)", fontSize: isMobile ? 16 : 15, fontFamily: "inherit" }}
      />
      <div style={srOnly} role="status" aria-live="polite">{flat.length ? t("nav.paletteCount", { n: flat.length }) : q ? t("nav.paletteNoResults", { q }) : ""}</div>
      <div id="cp-list" role="listbox" aria-label={t("nav.paletteListLabel")} style={{ maxHeight: "min(60vh, 420px)", overflowY: "auto", padding: 6 }}>
        {(() => {
          let idx = -1;
          return groups.map((g) => (
            <div key={g.group} role="group" aria-labelledby={`cp-g-${g.group}`}>
              <div id={`cp-g-${g.group}`} role="presentation" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--c-tx3)", padding: "8px 12px 4px" }}>
                {t(GROUP_LABEL_KEY[g.group])}
              </div>
              {g.items.map((r) => {
                idx += 1;
                const rowIdx = idx;
                const isActive = activeItem?.item.id === r.item.id;
                const dot = statusColor(r.item.status);
                return (
                  <div
                    key={r.item.id}
                    id={`cp-opt-${r.item.id}`}
                    role="option"
                    aria-selected={isActive}
                    onPointerMove={() => { byKeyboard.current = false; setActive(rowIdx); }}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => go(r.item.href)}
                    style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 40, padding: "7px 12px", borderRadius: "var(--r1)", cursor: "pointer", background: isActive ? "var(--c-el)" : "transparent", boxShadow: isActive ? "inset 2px 0 0 var(--c-lapis)" : "none" }}
                  >
                    {dot && <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, color: "var(--c-tx)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {highlightParts(r.item.label, r.labelIdx).map((p, i) => (p.hit ? <mark key={i} style={{ background: "transparent", color: "var(--c-tx)", fontWeight: 700 }}>{p.s}</mark> : <span key={i}>{p.s}</span>))}
                    </span>
                    {r.item.secondary && <span style={{ color: "var(--c-tx3)", fontSize: 11, maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>{r.item.secondary}</span>}
                  </div>
                );
              })}
            </div>
          ));
        })()}
        {flat.length === 0 && q && <div role="status" style={{ padding: "16px 12px", color: "var(--c-tx3)", fontSize: 13 }}>{t("nav.paletteNoResults", { q })}</div>}
        {loading && <div style={{ padding: "8px 12px", color: "var(--c-tx3)", fontSize: 12 }}>{t("nav.paletteLoading")}</div>}
      </div>
      {!isMobile && <div aria-hidden style={{ padding: "7px 14px", borderTop: "1px solid var(--c-bd)", color: "var(--c-tx3)", fontSize: 11 }}>{t("nav.paletteHint")}</div>}
    </Modal>
  );
}
