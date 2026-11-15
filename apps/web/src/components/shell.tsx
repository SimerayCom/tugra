"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { subscribeHubDown } from "../lib/hub-connection";
import type { InstanceUpdateNotice } from "../lib/types";
import { useAuth } from "../lib/auth";
import { DOCS_URL, SPONSOR_URL, whatsNewUrl } from "../lib/help-links";
import { navForMode, uiMode, isHomeAllowed } from "../lib/ui-mode";
import { useT } from "../i18n/provider";
import { useIsMobile } from "../hooks/useIsMobile";
import { nextThemeChoice, resolveThemeChoice, useAppearance, type ThemeChoice } from "../lib/appearance";
import { Spinner, ActivitySpinner, Btn } from "./ui";
import { useToast } from "./toast";
import { CommandPalette, type CommandDest } from "./command-palette";
import { TeamScopeSelect } from "./team-scope";
import { BrandMark } from "./branding";
import {
  Activity,
  ArrowUpCircle,
  BarChart3,
  Bell,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FolderTree,
  GitBranch,
  Globe,
  Cloud,
  KeyRound,
  DownloadCloud,
  HardDrive,
  Home,
  Package,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Palette,
  Plus,
  ScrollText,
  Search,
  Server,
  Boxes,
  BookOpen,
  Heart,
  Sparkles,
  Rocket,
  Settings,
  Store,
  Sun,
  Terminal,
  Users,
  Variable,
  X,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  key: string; // i18n key under "nav"
  href: string;
  icon: LucideIcon;
  home?: boolean; // shown in the simplified Home mode sidebar
  fleet?: boolean; // default true; set false for home-only items (hidden in fleet)
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "monitor",
    items: [
      { key: "home", href: "/home", icon: Home, home: true, fleet: false },
      { key: "dashboard", href: "/dashboard", icon: LayoutDashboard },
      { key: "fleet", href: "/fleet", icon: Gauge },
      { key: "traffic", href: "/traffic", icon: BarChart3 },
      { key: "uptime", href: "/monitors", icon: Activity },
    ],
  },
  {
    group: "build",
    items: [
      // Coolify-style: resources live under Projects → environment. Apps/Databases
      // aren't top-level nav; reach them via a project, the dashboard, or ⌘K.
      { key: "projects", href: "/projects", icon: FolderTree },
      { key: "appStore", href: "/app-store", icon: Store, home: true },
      { key: "import", href: "/import", icon: DownloadCloud },
      { key: "sources", href: "/sources", icon: GitBranch },
      { key: "registries", href: "/registries", icon: Package },
    ],
  },
  {
    group: "infrastructure",
    items: [
      { key: "servers", href: "/servers", icon: Server },
      { key: "clusters", href: "/clusters", icon: Boxes },
      { key: "rollouts", href: "/rollouts", icon: Rocket },
      { key: "terminal", href: "/shell", icon: Terminal },
      { key: "destinations", href: "/destinations", icon: HardDrive },
      { key: "domains", href: "/domains", icon: Globe },
      // Migration (discover + adopt foreign containers) lives per-server under a server's Maintenance
      // tab (discover-adopt-card), so there's no standalone page — no top-level nav entry for it.
    ],
  },
  {
    group: "integrations",
    items: [
      { key: "cloudCredentials", href: "/cloud-credentials", icon: Cloud },
      { key: "secretProviders", href: "/secret-providers", icon: KeyRound },
      { key: "sharedVars", href: "/shared-variables", icon: Variable },
    ],
  },
  {
    group: "account",
    items: [
      { key: "notifications", href: "/notifications", icon: Bell },
      { key: "audit", href: "/audit", icon: ScrollText },
      { key: "teams", href: "/teams", icon: Users },
      { key: "settings", href: "/settings", icon: Settings, home: true },
    ],
  },
];

export const DESTS: CommandDest[] = NAV.flatMap((g) =>
  g.items.map((i) => ({ labelKey: `nav.${i.key}`, href: i.href })),
).concat([
  // Not in the sidebar (resources live under Projects) but still ⌘K-reachable.
  { labelKey: "nav.apps", href: "/apps" },
  { labelKey: "nav.databases", href: "/databases" },
  { labelKey: "nav.addServer", href: "/servers/new" },
]);

export type ThemePref = ThemeChoice;

/** Cycle order for the header's quick theme control: System → Light → Dark → System (a custom theme is picked
 *  on Settings → Appearance; from it the cycle re-enters at System). */
export function nextTheme(pref: ThemePref): ThemePref {
  return nextThemeChoice(pref);
}
/** Resolve a preference to the concrete theme written to <html data-theme>; "system" follows the OS. */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): "light" | "dark" | "custom" {
  return resolveThemeChoice(pref, prefersDark);
}

/**
 * Theme preference (system / light / dark / custom) — a thin view over useAppearance(), which persists it
 * (`tugra.theme`), applies it to <html data-theme> (matching the pre-paint script in layout.tsx, so there is
 * no flash) and follows the OS live in system mode. Returns the preference, the resolved theme, a setter and
 * the cycle control.
 */
export function useTheme(): { pref: ThemePref; resolved: "light" | "dark" | "custom"; setPref: (p: ThemePref) => void; cycle: () => void } {
  const a = useAppearance();
  return { pref: a.theme, resolved: a.resolvedTheme, setPref: a.setTheme, cycle: a.cycleTheme };
}

export function CenteredSpinner() {
  return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Spinner />
    </div>
  );
}

export function Sidebar({ openPalette, mobile = false, open = false, onNavigate }: { openPalette: () => void; mobile?: boolean; open?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { logout, user } = useAuth();
  const mode = uiMode(user?.uiMode);
  const nav = navForMode(NAV, mode);
  const router = useRouter();
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(localStorage.getItem("tugra.sidebar") === "1");
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("tugra.sidebar", next ? "1" : "0");
      return next;
    });
  };

  // Per-group collapse (expanded sidebar only). Keys present = collapsed; hydrated after mount like the
  // sidebar collapse above so SSR and first client render agree (default = every group expanded).
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const closed: Record<string, boolean> = {};
    try {
      for (const g of NAV) if (localStorage.getItem(`tugra.navgroup.${g.group}`) === "1") closed[g.group] = true;
    } catch {
      /* storage unavailable: keep all groups expanded */
    }
    setClosedGroups(closed);
  }, []);
  const toggleGroup = (group: string) => {
    setClosedGroups((c) => {
      const isClosed = !c[group];
      try {
        localStorage.setItem(`tugra.navgroup.${group}`, isClosed ? "1" : "0");
      } catch {
        /* ignore */
      }
      return { ...c, [group]: isClosed };
    });
  };

  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const offline = servers.filter((s) => s.status === "OFFLINE").length;
  const version = useInstanceVersion();

  // On mobile the sidebar is a full-width off-canvas drawer (never icon-collapsed).
  const col = mobile ? false : collapsed;

  return (
    <aside
      className="tg-sidebar"
      // When the mobile drawer is slid off-screen it is still in the tab order and the a11y tree;
      // `inert` takes its links/buttons out of both until it is opened.
      {...(mobile && !open ? { inert: true } : {})}
      style={{
        width: col ? 56 : 232,
        flexShrink: 0,
        background: "var(--c-sb)",
        borderRight: "1px solid var(--c-bd)",
        // 100% (not 100vh) so the UI-scale zoom can't leave a gap under the sidebar; the mobile drawer is fixed.
        height: mobile ? "100vh" : "100%",
        display: "flex",
        flexDirection: "column",
        transition: mobile ? "transform .2s" : "width .15s",
        ...(mobile
          ? { position: "fixed", top: 0, left: 0, zIndex: 60, transform: `translateX(${open ? "0" : "-100%"})` }
          : { position: "sticky", top: 0 }),
      }}
    >
      <div style={{ padding: col ? "16px 0" : "16px 14px", borderBottom: "1px solid var(--c-bd)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: col ? "center" : "flex-start", gap: 9, marginBottom: 12 }}>
          <BrandMark size={36} nameSize={19} showName={!col} href="/dashboard" linkLabel={t("nav.goToDashboard")} version={version?.current ?? null} />
        </div>
        <button
          onClick={openPalette}
          title={t("nav.search")}
          aria-label={t("nav.search")}
          style={{ display: "flex", alignItems: "center", justifyContent: col ? "center" : "flex-start", gap: 8, width: col ? 32 : "100%", margin: col ? "0 auto" : undefined, padding: col ? "6px 0" : "6px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", cursor: "pointer", color: "var(--c-tx3)", fontSize: 12, fontFamily: "inherit" }}
        >
          {col ? (
            <Search size={15} />
          ) : (
            <>
              <span style={{ flex: 1, textAlign: "left" }}>{t("nav.search")}</span>
              <kbd className="mono" style={{ fontSize: 11, background: "var(--c-bd)", borderRadius: 3, padding: "1px 5px" }}>⌘K</kbd>
            </>
          )}
        </button>
      </div>

      <nav style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {nav.map((g) => {
          // Icon-collapsed mode has no headers, so per-group collapse never hides items there.
          const groupHasActive = g.items.some((it) => {
            const b = it.href.split("?")[0];
            return pathname === b || pathname.startsWith(`${b}/`);
          });
          const groupClosed = !col && !!closedGroups[g.group];
          const panelId = `tg-navgroup-${g.group}${mobile ? "-m" : ""}`;
          return (
          <div key={g.group}>
            {!col && (
              <button
                type="button"
                className="tg-nav-group"
                onClick={() => toggleGroup(g.group)}
                aria-expanded={!groupClosed}
                aria-controls={panelId}
              >
                <span style={{ flex: 1 }}>{t(`nav.group.${g.group}`)}</span>
                {groupClosed && groupHasActive && <span aria-hidden title={t("nav.activeInGroup")} style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--c-a)", marginRight: 4, flexShrink: 0 }} />}
                {groupClosed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
              </button>
            )}
            <div id={panelId} hidden={groupClosed}>
            {g.items.map((it) => {
              const base = it.href.split("?")[0];
              const active = pathname === base || pathname.startsWith(`${base}/`);
              const Icon = it.icon;
              const badge = mode !== "home" && it.key === "servers" && offline > 0 ? offline : 0;
              return (
                <Link
                  key={it.key}
                  href={it.href}
                  onClick={onNavigate}
                  title={col ? t(`nav.${it.key}`) : undefined}
                  aria-label={col ? t(`nav.${it.key}`) : undefined}
                  aria-current={active ? "page" : undefined}
                  className="tg-nav-link"
                  style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: col ? "center" : "flex-start", gap: 9, padding: col ? "8px 0" : "6px 10px", borderRadius: "var(--r1)", marginBottom: 1, fontSize: 13, textDecoration: "none" }}
                >
                  <Icon size={15} strokeWidth={active ? 2.4 : 2} style={{ flexShrink: 0 }} />
                  {!col && <span style={{ flex: 1 }}>{t(`nav.${it.key}`)}</span>}
                  {badge > 0 && (
                    col ? (
                      <span style={{ position: "absolute", top: 5, right: 9, width: 7, height: 7, borderRadius: "50%", background: "var(--c-r)" }} />
                    ) : (
                      <span style={{ fontSize: 11, fontWeight: 700, background: "var(--c-danger-fill)", color: "var(--c-on-danger)", borderRadius: 999, padding: "0 6px", minWidth: 16, textAlign: "center" }}>{badge}</span>
                    )
                  )}
                </Link>
              );
            })}
            </div>
          </div>
          );
        })}
      </nav>

      {/* Pinned footer, kept to two short rows so the nav above keeps its room (Coolify pins the same block:
          a distinct "Sponsor" pill, the help links as icons, then sign-out). Collapsed: one icon column. */}
      <div className="tg-sidebar-foot" style={{ padding: col ? "8px 0" : 8, borderTop: "1px solid var(--c-bd)", display: "flex", flexDirection: "column", gap: 4, alignItems: col ? "center" : "stretch" }}>
        <div style={{ display: "flex", flexDirection: col ? "column" : "row", alignItems: "center", gap: 4 }}>
          <a
            href={SPONSOR_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="help-sponsor"
            title={t("nav.sponsorHint")}
            aria-label={t("nav.sponsor")}
            className="tg-foot-sponsor"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, flex: col ? undefined : 1, minWidth: 0, height: 30, padding: col ? 0 : "0 10px", width: col ? 32 : undefined, borderRadius: "var(--r1)", background: "color-mix(in srgb, var(--c-a) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--c-a) 35%, transparent)", color: "var(--c-tx)", fontSize: 12.5, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}
          >
            <Heart size={14} aria-hidden style={{ flexShrink: 0, color: "var(--c-a)" }} />
            {!col && t("nav.sponsor")}
          </a>
          {([
            { key: "whatsNew", href: whatsNewUrl(version?.current), icon: Sparkles },
            { key: "docs", href: DOCS_URL, icon: BookOpen },
          ] as const).map((l) => (
            <a
              key={l.key}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`help-${l.key}`}
              title={t(`nav.${l.key}`)}
              aria-label={t(`nav.${l.key}`)}
              className="tg-foot-icon"
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 30, flexShrink: 0, borderRadius: "var(--r1)", color: "var(--c-tx3)", textDecoration: "none" }}
            >
              <l.icon size={15} aria-hidden />
            </a>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: col ? "column" : "row", alignItems: "center", gap: 4 }}>
          <button
            onClick={async () => {
              await logout();
              router.replace("/login");
            }}
            title={t("nav.logout")}
            aria-label={t("nav.logout")}
            className="tg-foot-icon"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: col ? "center" : "flex-start", gap: 8, flex: col ? undefined : 1, width: col ? 32 : undefined, height: 30, padding: col ? 0 : "0 8px", background: "transparent", border: "none", borderRadius: "var(--r1)", color: "var(--c-tx3)", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}
          >
            <LogOut size={15} aria-hidden style={{ flexShrink: 0 }} />
            {!col && t("nav.logout")}
          </button>
          {!mobile && (
            <button
              onClick={toggleCollapsed}
              title={col ? t("nav.expand") : t("nav.collapse")}
              aria-label={col ? t("nav.expand") : t("nav.collapse")}
              className="tg-foot-icon"
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, width: 32, height: 30, flexShrink: 0, background: "transparent", border: "none", borderRadius: "var(--r1)", color: "var(--c-tx3)", cursor: "pointer", fontFamily: "inherit" }}
            >
              {col ? <ChevronsRight size={15} aria-hidden /> : <ChevronsLeft size={15} aria-hidden />}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function NewMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const items = [
    { label: t("nav.newResource"), href: "/resources/new" },
    { label: t("nav.newProject"), href: "/projects/new" },
    { label: t("nav.newServer"), href: "/servers/new" },
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--c-a)", color: "var(--c-on-a)", fontWeight: 600, fontSize: 13, padding: "6px 12px", borderRadius: "var(--r1)", border: "none", cursor: "pointer", fontFamily: "inherit" }}
      >
        <Plus size={15} aria-hidden /> {t("nav.new")}
      </button>
      {open && (
        <div role="menu" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 180, background: "var(--c-sb)", border: "1px solid var(--c-bd)", borderRadius: "var(--r2)", boxShadow: "0 8px 24px rgba(0,0,0,0.3)", padding: 6, zIndex: 50 }}>
          {items.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              style={{ display: "block", padding: "8px 10px", borderRadius: "var(--r1)", fontSize: 13, color: "var(--c-tx)", textDecoration: "none" }}
            >
              {it.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** The running version + "newer release published" flag every signed-in member may read (session-guarded
 *  GET /instance/version). Rarely changes, so it is kept fresh for a while instead of refetched per mount. */
export function useInstanceVersion() {
  const { user } = useAuth();
  const { data } = useQuery({ queryKey: ["instanceVersion"], queryFn: () => api.getInstanceVersion(), enabled: !!user, staleTime: 5 * 60_000 });
  return data ?? null;
}

const badgeStyle = (compact?: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 32,
  padding: compact ? "6px 8px" : "6px 10px",
  background: "color-mix(in srgb, var(--c-a) 14%, transparent)",
  border: "1px solid color-mix(in srgb, var(--c-a) 40%, transparent)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12.5,
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
});

/** Top-bar pill that surfaces an available self-update automatically — without anyone having to open
 *  Settings and press "check". For the owner it links straight to the Updates card and shares the
 *  ["instanceUpdate"] query with that card and the notice banner (no extra request). Every other member
 *  sees the same pill from the member-level version query, as a status (not a link) whose title says the
 *  owner applies it. Hidden when up to date. Compact (icon only) on mobile, where the header has little room. */
export function UpdateBadge({ compact }: { compact?: boolean }) {
  const { user } = useAuth();
  const t = useT();
  const isOwner = !!user?.isInstanceOwner;
  const { data: ownerData } = useQuery({ queryKey: ["instanceUpdate"], queryFn: () => api.getInstanceUpdate(), enabled: isOwner });
  const member = useInstanceVersion();
  const data = isOwner ? ownerData : member;
  if (!data?.updateAvailable) return null;
  const label = data.latest ? `${t("settings.updateAvailable")} — ${data.latest}` : t("settings.updateAvailable");
  const icon = <ArrowUpCircle size={15} aria-hidden style={{ color: "var(--c-a)", flexShrink: 0 }} />;
  if (!isOwner) {
    const hint = `${label}. ${t("settings.updateOwnerApplies")}`;
    return (
      <span role="status" title={hint} aria-label={hint} style={badgeStyle(compact)}>
        {icon}
        {!compact && <span>{label}</span>}
      </span>
    );
  }
  return (
    <Link href="/settings?tab=instance&section=backups#updates" title={label} aria-label={label} style={badgeStyle(compact)}>
      {icon}
      {!compact && <span>{label}</span>}
    </Link>
  );
}

function TopHeader({ onMenu, showMenu }: { onMenu?: () => void; showMenu?: boolean }) {
  const { user } = useAuth();
  const t = useT();
  const { pref: themePref, cycle: cycleTheme } = useTheme();
  const themeMode = themePref === "system" ? t("nav.themeSystem") : themePref === "light" ? t("nav.themeLight") : themePref === "custom" ? t("nav.themeCustom") : t("nav.themeDark");
  const ThemeIcon = themePref === "system" ? Monitor : themePref === "light" ? Sun : themePref === "custom" ? Palette : Moon;
  // Home mode hides fleet-only chrome (bulk "New", team scoping).
  const isHome = uiMode(user?.uiMode) === "home";
  return (
    <header style={{ height: 52, flexShrink: 0, borderBottom: "1px solid var(--c-bd)", display: "flex", alignItems: "center", gap: 14, padding: "0 18px", background: "var(--c-bg)" }}>
      {showMenu && (
        <button onClick={onMenu} title={t("nav.menu")} aria-label={t("nav.menu")} style={{ display: "flex", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44, background: "transparent", border: "none", padding: 4, cursor: "pointer", color: "var(--c-tx2)", marginLeft: -8 }}>
          <Menu size={20} />
        </button>
      )}
      {!isHome && <NewMenu />}
      <div style={{ flex: 1 }} />
      <UpdateBadge compact={showMenu} />
      {!isHome && <TeamScopeSelect />}
      <button onClick={cycleTheme} title={t("nav.themeLabel", { mode: themeMode })} aria-label={t("nav.themeLabel", { mode: themeMode })} style={{ display: "flex", alignItems: "center", justifyContent: "center", minWidth: 34, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "6px 9px", cursor: "pointer", color: "var(--c-tx2)", fontFamily: "inherit" }}>
        <ThemeIcon size={15} aria-hidden />
      </button>
      {!showMenu && <span style={{ fontSize: 13, color: "var(--c-tx2)" }}>{user?.email}</span>}
    </header>
  );
}

/** Amber strip shown while the signed-in user's email is unverified, with a one-click resend. */
function VerifyBanner() {
  const { user } = useAuth();
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Same public status the rest of the app caches; only fetched for an unverified signed-in user.
  const { data: status } = useQuery({
    queryKey: ["instanceStatus"],
    queryFn: () => api.getInstanceStatus(),
    staleTime: 60_000,
    enabled: !!user && !user.emailVerified,
  });
  if (!user || user.emailVerified) return null;
  // The hub cannot send any email → don't nag the user to verify (they could never receive the link).
  if (status?.mailConfigured === false) return null;
  const resend = async () => {
    // Defensive: the banner is hidden when mail is off, but never claim "sent" if status says otherwise.
    if (status?.mailConfigured === false) {
      toast(t("auth.resendNoMail"), "error");
      return;
    }
    setBusy(true);
    try {
      await api.resendVerification();
      toast(t("auth.resendSent"), "success");
    } catch {
      toast(t("auth.resendFailed"), "error");
    }
    setBusy(false);
  };
  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "8px 18px",
        background: "color-mix(in srgb, var(--c-am) 14%, transparent)",
        borderBottom: "1px solid var(--c-bd)",
        fontSize: 13,
        color: "var(--c-tx2)",
      }}
    >
      <span style={{ flex: 1, minWidth: 180 }}>{t("auth.verifyBanner")}</span>
      <Btn variant="ghost" onClick={resend} disabled={busy}>
        {busy ? "…" : t("auth.resend")}
      </Btn>
    </div>
  );
}

const NOTICE_DISMISS_KEY = "tugra.noticeDismissed";

/** Whether a notice banner should render: present, and (unless critical) not already dismissed by id. */
export function noticeVisible(notice: InstanceUpdateNotice | null | undefined, dismissedId: string | null): boolean {
  if (!notice) return false;
  if (notice.severity === "critical") return true; // critical is non-dismissible
  return dismissedId !== notice.id;
}

/** A parenthesised semver such as "(0.1.0-beta.2)" / "(v1.2.3)"; group 1 is the bare version. */
const PAREN_VERSION = /\s*\(\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*\)/g;

/**
 * The banner text, made version-proof. The notice is signed free text authored at publish time, so a baked-in
 * self-reference like "(0.1.0-beta.2)" goes stale the moment the instance updates. We therefore (1) replace a
 * `{version}` placeholder with the ACTUAL running version (when known) and (2) drop ONLY the parenthesised version
 * that equals the running version (the stale self-reference). A different parenthesised version is an intended
 * target ("Security fix in (0.1.1), please upgrade") and is kept.
 */
export function noticeMessage(message: string, running?: string | null): string {
  const withVersion = running ? message.replace(/\{version\}/g, running) : message.replace(/\s*\{version\}/g, "");
  const bare = running ? running.replace(/^v/, "") : null;
  const stripped = bare
    ? withVersion.replace(PAREN_VERSION, (m, v: string) => (v === bare ? "" : m))
    : withVersion;
  return stripped.replace(/\s{2,}/g, " ").trim();
}

/**
 * Owner-only, dismissible strip for a signed operator notice delivered through the update manifest
 * (security advisory, "please upgrade to beta.2", etc.). Shares the ["instanceUpdate"] query with the
 * Settings Updates card, so it adds no extra request. The message is rendered as PLAIN TEXT (it is signed
 * but still untrusted free text); the optional link is https-only (enforced server-side).
 */
function NoticeBanner() {
  const { user } = useAuth();
  const t = useT();
  const isOwner = !!user?.isInstanceOwner;
  const { data } = useQuery({ queryKey: ["instanceUpdate"], queryFn: () => api.getInstanceUpdate(), enabled: isOwner });
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDismissedId(localStorage.getItem(NOTICE_DISMISS_KEY));
    } catch {
      /* no storage → the notice simply stays visible */
    }
  }, []);
  const notice = data?.notice ?? null;
  if (!isOwner || !noticeVisible(notice, dismissedId) || !notice) return null;

  const tone =
    notice.severity === "critical" ? "var(--c-r)" : notice.severity === "warning" ? "var(--c-am)" : "var(--c-a)";
  const label =
    notice.severity === "critical"
      ? t("settings.noticeCritical")
      : notice.severity === "warning"
        ? t("settings.noticeWarning")
        : t("settings.noticeInfo");
  const dismiss = () => {
    try {
      localStorage.setItem(NOTICE_DISMISS_KEY, notice.id);
    } catch {
      /* ignore */
    }
    setDismissedId(notice.id);
  };
  return (
    <div
      role={notice.severity === "critical" ? "alert" : "status"}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "8px 18px",
        background: `color-mix(in srgb, ${tone} 14%, transparent)`,
        borderBottom: "1px solid var(--c-bd)",
        fontSize: 13,
        color: "var(--c-tx2)",
      }}
    >
      <span style={{ flex: 1, minWidth: 180 }}>
        <strong style={{ color: tone }}>{label}:</strong> {noticeMessage(notice.message, data?.current)}
      </span>
      {notice.url && (
        <a href={notice.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-a)", whiteSpace: "nowrap" }}>
          {t("settings.noticeLearnMore")}
        </a>
      )}
      {notice.severity !== "critical" && (
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("settings.noticeDismiss")}
          title={t("settings.noticeDismiss")}
          style={{ display: "inline-flex", background: "none", border: "none", cursor: "pointer", color: "var(--c-tx2)", padding: 4 }}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

/** First wait before pinging the hub again, and the cap the backoff grows to. */
export const HUB_PING_BASE_MS = 3000;
export const HUB_PING_MAX_MS = 15000;
/** Backoff: 3s, 4.5s, 6.75s … capped at 15s, so a long outage doesn't hammer the proxy. */
export function nextHubPingDelay(prev: number): number {
  return Math.min(HUB_PING_MAX_MS, Math.round(prev * 1.5));
}

/**
 * Amber, non-blocking strip above the header while the hub is restarting/unreachable. It appears when an API
 * request hit that condition (apiFetch → reportHubDown), pings the public /instance/status (no auth) with
 * backoff until it answers, then hides and refetches every query so stale/errored screens heal themselves.
 */
export function HubConnectionBanner() {
  const t = useT();
  const qc = useQueryClient();
  const [down, setDown] = useState(false);
  const [attempt, setAttempt] = useState(0); // bumping it restarts the ping loop ("Retry now")

  useEffect(() => subscribeHubDown(() => setDown(true)), []);

  useEffect(() => {
    if (!down) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ping = async (delay: number) => {
      let alive = false;
      try {
        const res = await fetch("/api/v1/instance/status", { cache: "no-store" });
        alive = res.ok;
      } catch {
        /* still down */
      }
      if (cancelled) return;
      if (alive) {
        setDown(false);
        void qc.invalidateQueries();
        return;
      }
      const next = nextHubPingDelay(delay);
      timer = setTimeout(() => void ping(next), next);
    };
    // "Retry now" (attempt > 0) pings immediately; the first detection waits one base interval.
    const first = attempt === 0 ? HUB_PING_BASE_MS : 0;
    timer = setTimeout(() => void ping(HUB_PING_BASE_MS), first);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [down, attempt, qc]);

  if (!down) return null;
  return (
    <div
      role="status"
      data-testid="hub-connection-banner"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "8px 18px",
        background: "color-mix(in srgb, var(--c-am) 16%, var(--c-bg))",
        borderBottom: "1px solid var(--c-am)",
        color: "var(--c-tx)",
        fontSize: 13,
      }}
    >
      <ActivitySpinner size={14} />
      <span style={{ flex: 1, minWidth: 0 }}>{t("errors.hubBannerTitle")}</span>
      <Btn variant="ghost" onClick={() => setAttempt((a) => a + 1)}>{t("errors.hubBannerRetry")}</Btn>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const isHome = uiMode(user?.uiMode) === "home";
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        // Don't steal Ctrl+K from a focused terminal (readline kill-line / nano cut).
        if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (e.key === "Escape") { setPalette(false); setDrawer(false); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return (
    <div className="tg-shell" style={{ display: "flex", height: "100%" }}>
      {isMobile ? (
        <Sidebar openPalette={() => { setDrawer(false); setPalette(true); }} mobile open={drawer} onNavigate={() => setDrawer(false)} />
      ) : (
        <Sidebar openPalette={() => setPalette(true)} />
      )}
      {isMobile && drawer && (
        <div onClick={() => setDrawer(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 55 }} />
      )}
      <div className="tg-content" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <HubConnectionBanner />
        <TopHeader onMenu={() => setDrawer(true)} showMenu={isMobile} />
        <VerifyBanner />
        <NoticeBanner />
        <main className="tg-main" style={{ flex: 1, overflowY: "auto" }}>{children}</main>
      </div>
      {/* In Home mode, ⌘K only offers Home-allowed destinations (a fleet route would just bounce to /home). */}
      {palette && <CommandPalette dests={isHome ? DESTS.filter((d) => isHomeAllowed(d.href)) : DESTS} fleet={!isHome} onClose={() => setPalette(false)} />}
    </div>
  );
}
