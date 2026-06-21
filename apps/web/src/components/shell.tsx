"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { useT } from "../i18n/provider";
import { Spinner } from "./ui";
import { CommandPalette, type CommandDest } from "./command-palette";
import {
  Activity,
  ArrowLeftRight,
  Box,
  Database,
  FolderTree,
  Globe,
  HardDrive,
  LayoutDashboard,
  Server,
  Settings,
  Users,
  Variable,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  key: string; // i18n key under "nav"
  href: string;
  icon: LucideIcon;
  impl?: boolean;
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Monitor",
    items: [
      { key: "dashboard", href: "/dashboard", icon: LayoutDashboard, impl: true },
      { key: "uptime", href: "/monitors", icon: Activity, impl: true },
    ],
  },
  {
    group: "Resources",
    items: [
      { key: "servers", href: "/servers", icon: Server, impl: true },
      { key: "projects", href: "/projects", icon: FolderTree, impl: true },
      { key: "apps", href: "/apps", icon: Box, impl: true },
      { key: "databases", href: "/databases", icon: Database, impl: true },
      { key: "destinations", href: "/destinations", icon: HardDrive, impl: true },
      { key: "sharedVars", href: "/shared-variables", icon: Variable, impl: true },
      { key: "domains", href: "/domains", icon: Globe, impl: true },
      { key: "migration", href: "/coming-soon?f=Migration", icon: ArrowLeftRight },
    ],
  },
  {
    group: "Account",
    items: [
      { key: "teams", href: "/teams", icon: Users, impl: true },
      { key: "settings", href: "/settings", icon: Settings, impl: true },
    ],
  },
];

export const DESTS: CommandDest[] = NAV.flatMap((g) =>
  g.items.map((i) => ({ labelKey: `nav.${i.key}`, href: i.href })),
).concat([{ labelKey: "nav.addServer", href: "/servers/new" }]);

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

function Sidebar({ openPalette }: { openPalette: () => void }) {
  const pathname = usePathname();
  const { logout } = useAuth();
  const router = useRouter();
  const t = useT();
  return (
    <aside
      style={{
        width: 232,
        flexShrink: 0,
        background: "var(--c-sb)",
        borderRight: "1px solid var(--c-bd)",
        height: "100vh",
        position: "sticky",
        top: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "16px 14px", borderBottom: "1px solid var(--c-bd)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-seal.png" alt="Tugra" width={28} height={28} style={{ borderRadius: 7 }} />
          <div style={{ fontWeight: 700, fontSize: 15 }}>Tugra</div>
        </div>
        <button
          onClick={openPalette}
          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", cursor: "pointer", color: "var(--c-tx3)", fontSize: 12, fontFamily: "inherit" }}
        >
          <span style={{ flex: 1, textAlign: "left" }}>{t("nav.search")}</span>
          <kbd className="mono" style={{ fontSize: 10, background: "var(--c-bd)", borderRadius: 3, padding: "1px 5px" }}>⌘K</kbd>
        </button>
      </div>

      <nav style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
        {NAV.map((g) => (
          <div key={g.group}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "10px 10px 3px" }}>
              {g.group}
            </div>
            {g.items.map((it) => {
              const active = pathname === it.href.split("?")[0];
              const Icon = it.icon;
              return (
                <Link
                  key={it.key}
                  href={it.href}
                  style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 10px", borderRadius: "var(--r1)", marginBottom: 1, fontSize: 13, textDecoration: "none", background: active ? "var(--c-ad)" : "transparent", color: active ? "var(--c-a)" : "var(--c-tx2)", fontWeight: active ? 600 : 400 }}
                >
                  <Icon size={15} strokeWidth={active ? 2.4 : 2} style={{ flexShrink: 0 }} />
                  {t(`nav.${it.key}`)}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div style={{ padding: 8, borderTop: "1px solid var(--c-bd)" }}>
        <button
          onClick={async () => {
            await logout();
            router.replace("/login");
          }}
          style={{ width: "100%", padding: "6px 10px", background: "transparent", border: "none", color: "var(--c-tx3)", fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
        >
          {t("nav.logout")}
        </button>
      </div>
    </aside>
  );
}

function TopHeader() {
  const { user } = useAuth();
  const [theme, toggle] = useTheme();
  return (
    <header style={{ height: 52, flexShrink: 0, borderBottom: "1px solid var(--c-bd)", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 14, padding: "0 18px", background: "var(--c-bg)" }}>
      <button onClick={toggle} title="Toggle theme" style={{ background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "5px 10px", cursor: "pointer", color: "var(--c-tx2)", fontSize: 12, fontFamily: "inherit" }}>
        {theme === "dark" ? "☾" : "☀"}
      </button>
      <span style={{ fontSize: 13, color: "var(--c-tx2)" }}>{user?.email}</span>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (e.key === "Escape") setPalette(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return (
    <div style={{ display: "flex", height: "100%" }}>
      <Sidebar openPalette={() => setPalette(true)} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <TopHeader />
        <main style={{ flex: 1, overflowY: "auto" }}>{children}</main>
      </div>
      {palette && <CommandPalette dests={DESTS} onClose={() => setPalette(false)} />}
    </div>
  );
}
