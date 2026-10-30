"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { navForMode, uiMode, isHomeAllowed } from "../lib/ui-mode";
import { useT } from "../i18n/provider";
import { useIsMobile } from "../hooks/useIsMobile";
import { Spinner, Btn } from "./ui";
import { useToast } from "./toast";
import { CommandPalette, type CommandDest } from "./command-palette";
import { TeamScopeSelect } from "./team-scope";
import { BrandMark } from "./branding";
import {
  Activity,
  Bell,
  ChevronsLeft,
  ChevronsRight,
  FolderTree,
  GitBranch,
  Globe,
  Cloud,
  DownloadCloud,
  HardDrive,
  Home,
  Package,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Plus,
  ScrollText,
  Search,
  Server,
  Boxes,
  Settings,
  Store,
  Sun,
  Terminal,
  Users,
  Variable,
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
    group: "Monitor",
    items: [
      { key: "home", href: "/home", icon: Home, home: true, fleet: false },
      { key: "dashboard", href: "/dashboard", icon: LayoutDashboard },
      { key: "fleet", href: "/fleet", icon: Gauge },
      { key: "uptime", href: "/monitors", icon: Activity },
    ],
  },
  {
    group: "Resources",
    items: [
      // Coolify-style: resources live under Projects → environment. Apps/Databases
      // aren't top-level nav; reach them via a project, the dashboard, or ⌘K.
      { key: "projects", href: "/projects", icon: FolderTree },
      { key: "appStore", href: "/app-store", icon: Store, home: true },
      { key: "servers", href: "/servers", icon: Server },
      { key: "clusters", href: "/clusters", icon: Boxes },
      { key: "terminal", href: "/shell", icon: Terminal },
      { key: "import", href: "/import", icon: DownloadCloud },
      { key: "sources", href: "/sources", icon: GitBranch },
      { key: "registries", href: "/registries", icon: Package },
      { key: "cloudCredentials", href: "/cloud-credentials", icon: Cloud },
      { key: "destinations", href: "/destinations", icon: HardDrive },
      { key: "sharedVars", href: "/shared-variables", icon: Variable },
      { key: "domains", href: "/domains", icon: Globe },
      // Migration (discover + adopt foreign containers) lives per-server under a server's Maintenance
      // tab (discover-adopt-card), so there's no standalone page — no top-level nav entry for it.
    ],
  },
  {
    group: "Account",
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

export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    const saved = localStorage.getItem("tugra.theme") ?? "dark";
    setTheme(saved);
    document.documentElement.setAttribute("data-theme", saved);
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("tugra.theme", next);
    document.documentElement.setAttribute("data-theme", next);
  };
  return [theme, toggle];
}

export function CenteredSpinner() {
  return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Spinner />
    </div>
  );
}

function Sidebar({ openPalette, mobile = false, open = false, onNavigate }: { openPalette: () => void; mobile?: boolean; open?: boolean; onNavigate?: () => void }) {
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

  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const offline = servers.filter((s) => s.status === "OFFLINE").length;

  // On mobile the sidebar is a full-width off-canvas drawer (never icon-collapsed).
  const col = mobile ? false : collapsed;

  return (
    <aside
      // When the mobile drawer is slid off-screen it is still in the tab order and the a11y tree;
      // `inert` takes its links/buttons out of both until it is opened.
      {...(mobile && !open ? { inert: true } : {})}
      style={{
        width: col ? 56 : 232,
        flexShrink: 0,
        background: "var(--c-sb)",
        borderRight: "1px solid var(--c-bd)",
        height: "100vh",
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
          <BrandMark size={36} nameSize={19} showName={!col} />
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
              <kbd className="mono" style={{ fontSize: 10, background: "var(--c-bd)", borderRadius: 3, padding: "1px 5px" }}>⌘K</kbd>
            </>
          )}
        </button>
      </div>

      <nav style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {nav.map((g) => (
          <div key={g.group}>
            {!col && (
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "10px 10px 3px" }}>
                {g.group}
              </div>
            )}
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
                  style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: col ? "center" : "flex-start", gap: 9, padding: col ? "8px 0" : "6px 10px", borderRadius: "var(--r1)", marginBottom: 1, fontSize: 13, textDecoration: "none", background: active ? "var(--c-ad)" : "transparent", color: active ? "var(--c-a)" : "var(--c-tx2)", fontWeight: active ? 600 : 400 }}
                >
                  <Icon size={15} strokeWidth={active ? 2.4 : 2} style={{ flexShrink: 0 }} />
                  {!col && <span style={{ flex: 1 }}>{t(`nav.${it.key}`)}</span>}
                  {badge > 0 && (
                    col ? (
                      <span style={{ position: "absolute", top: 5, right: 9, width: 7, height: 7, borderRadius: "50%", background: "var(--c-r)" }} />
                    ) : (
                      <span style={{ fontSize: 10, fontWeight: 700, background: "var(--c-r)", color: "#fff", borderRadius: 999, padding: "0 6px", minWidth: 16, textAlign: "center" }}>{badge}</span>
                    )
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div style={{ padding: 8, borderTop: "1px solid var(--c-bd)", display: "flex", flexDirection: "column", gap: 2 }}>
        <button
          onClick={async () => {
            await logout();
            router.replace("/login");
          }}
          title={col ? t("nav.logout") : undefined}
          aria-label={col ? t("nav.logout") : undefined}
          style={{ display: "flex", alignItems: "center", justifyContent: col ? "center" : "flex-start", gap: 9, width: "100%", padding: "6px 10px", background: "transparent", border: "none", color: "var(--c-tx3)", fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
        >
          <LogOut size={15} style={{ flexShrink: 0 }} />
          {!col && t("nav.logout")}
        </button>
        {!mobile && (
          <button
            onClick={toggleCollapsed}
            title={col ? t("nav.expand") : t("nav.collapse")}
            aria-label={col ? t("nav.expand") : t("nav.collapse")}
            style={{ display: "flex", alignItems: "center", justifyContent: col ? "center" : "flex-start", gap: 9, width: "100%", padding: "6px 10px", background: "transparent", border: "none", color: "var(--c-tx3)", fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
          >
            {col ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
            {!col && t("nav.collapse")}
          </button>
        )}
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

function TopHeader({ onMenu, showMenu }: { onMenu?: () => void; showMenu?: boolean }) {
  const { user } = useAuth();
  const t = useT();
  const [theme, toggle] = useTheme();
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
      {!isHome && <TeamScopeSelect />}
      <button onClick={toggle} title={t("nav.toggleTheme")} aria-label={t("nav.toggleTheme")} aria-pressed={theme === "dark"} style={{ display: "flex", alignItems: "center", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "6px 9px", cursor: "pointer", color: "var(--c-tx2)", fontFamily: "inherit" }}>
        {theme === "dark" ? <Moon size={15} aria-hidden /> : <Sun size={15} aria-hidden />}
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
  if (!user || user.emailVerified) return null;
  const resend = async () => {
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
    <div style={{ display: "flex", height: "100%" }}>
      {isMobile ? (
        <Sidebar openPalette={() => { setDrawer(false); setPalette(true); }} mobile open={drawer} onNavigate={() => setDrawer(false)} />
      ) : (
        <Sidebar openPalette={() => setPalette(true)} />
      )}
      {isMobile && drawer && (
        <div onClick={() => setDrawer(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 55 }} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <TopHeader onMenu={() => setDrawer(true)} showMenu={isMobile} />
        <VerifyBanner />
        <main style={{ flex: 1, overflowY: "auto" }}>{children}</main>
      </div>
      {/* In Home mode, ⌘K only offers Home-allowed destinations (a fleet route would just bounce to /home). */}
      {palette && <CommandPalette dests={isHome ? DESTS.filter((d) => isHomeAllowed(d.href)) : DESTS} onClose={() => setPalette(false)} />}
    </div>
  );
}
