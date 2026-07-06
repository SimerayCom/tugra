"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Boxes, ExternalLink, MoreVertical } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { launcherTiles, type LauncherTile } from "../../../lib/launcher";
import { appColor } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Btn, EmptyState, Spinner } from "../../../components/ui";
import { SetDomainModal } from "../../../components/set-domain-modal";
import { TileActionsSheet } from "../../../components/tile-actions-sheet";
import { AppLogo } from "../../../components/app-logo";

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: 14,
};

export default function HomePage() {
  const t = useT();
  // Fleet-mode users belong on the command center, not the launcher.
  const { user } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (user?.uiMode === "fleet") router.replace("/dashboard");
  }, [user?.uiMode, router]);

  const { data: apps = [], isLoading } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const tiles = launcherTiles(apps);
  const [addDomainFor, setAddDomainFor] = useState<string | null>(null);
  const [actionsFor, setActionsFor] = useState<LauncherTile | null>(null);

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("home.title")}</h1>
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 20px" }}>{t("home.subtitle")}</p>

      {isLoading ? (
        <Spinner />
      ) : tiles.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={t("home.noAppsTitle")}
          action={<Link href="/app-store"><Btn>{t("home.browseStore")}</Btn></Link>}
        >
          {t("home.noApps")}
        </EmptyState>
      ) : (
        <div style={grid}>
          {tiles.map((tile) => (
            <Tile key={tile.id} tile={tile} openLabel={t("home.open")} manageLabel={t("home.manage")} onManage={() => setActionsFor(tile)} />
          ))}
        </div>
      )}

      {addDomainFor && <SetDomainModal appId={addDomainFor} onClose={() => setAddDomainFor(null)} />}
      {actionsFor && (
        <TileActionsSheet
          tile={actionsFor}
          onClose={() => setActionsFor(null)}
          onAddDomain={(id) => setAddDomainFor(id)}
        />
      )}
    </div>
  );
}

function Tile({ tile, openLabel, manageLabel, onManage }: { tile: LauncherTile; openLabel: string; manageLabel: string; onManage: () => void }) {
  const menuBtn = (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onManage(); }}
      title={manageLabel}
      aria-label={manageLabel}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 6, background: "transparent", border: "none", cursor: "pointer", color: "var(--c-tx3)" }}
    >
      <MoreVertical size={16} />
    </button>
  );

  const inner = (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ width: 48, height: 48, borderRadius: 12, background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <AppLogo templateSlug={tile.templateSlug} templateLogo={tile.templateLogo} source={tile.source} name={tile.name} size={26} />
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span title={tile.status} style={{ width: 9, height: 9, borderRadius: "50%", background: appColor(tile.status) }} />
          {(tile.url || tile.canWrite) && menuBtn}
        </div>
      </div>
      <div style={{ fontWeight: 600, fontSize: 15, marginTop: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.name}</div>
      {tile.url && (
        <div style={{ fontSize: 12, color: "var(--c-lapis)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
          <ExternalLink size={12} /> {openLabel}
        </div>
      )}
    </>
  );

  const boxStyle: React.CSSProperties = {
    display: "block", padding: 16, borderRadius: "var(--r2)", border: "1px solid var(--c-bd)",
    background: "var(--c-el)", textDecoration: "none", color: "var(--c-tx)",
  };

  // With a domain the whole tile launches the app; without one it's informational
  // (manage it — including adding a domain — from the ⋯ menu).
  if (!tile.url) {
    return <div style={boxStyle}>{inner}</div>;
  }
  return (
    <a href={tile.url} target="_blank" rel="noreferrer" style={boxStyle}>
      {inner}
    </a>
  );
}
