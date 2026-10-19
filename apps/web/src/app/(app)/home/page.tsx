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
import { ErrorState } from "../../../components/error-state";
import { ExposeModal } from "../../../components/expose-modal";
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

  const { data: apps = [], isLoading, isError, refetch } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const tiles = launcherTiles(apps);
  const [exposeFor, setExposeFor] = useState<string | null>(null);
  const [actionsFor, setActionsFor] = useState<LauncherTile | null>(null);

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("home.title")}</h1>
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 20px" }}>{t("home.subtitle")}</p>

      {isError && tiles.length === 0 ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
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
            <Tile key={tile.id} tile={tile} t={t} onManage={() => setActionsFor(tile)} onExpose={() => setExposeFor(tile.id)} />
          ))}
        </div>
      )}

      {exposeFor &&
        (() => {
          const tile = tiles.find((t) => t.id === exposeFor);
          return tile ? (
            <ExposeModal
              appId={tile.id}
              current={tile.exposeMode}
              currentDomain={tile.domain}
              onClose={() => setExposeFor(null)}
            />
          ) : null;
        })()}
      {actionsFor && (
        <TileActionsSheet
          tile={actionsFor}
          onClose={() => setActionsFor(null)}
          onExpose={(id) => setExposeFor(id)}
        />
      )}
    </div>
  );
}

function Tile({ tile, t, onManage, onExpose }: { tile: LauncherTile; t: ReturnType<typeof useT>; onManage: () => void; onExpose: () => void }) {
  const manageLabel = t("home.manage");
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
        <span style={{ width: 48, height: 48, borderRadius: 12, background: "color-mix(in srgb, var(--c-tx) 8%, transparent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <AppLogo templateSlug={tile.templateSlug} templateLogo={tile.templateLogo} source={tile.source} name={tile.name} size={26} />
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span title={tile.status} style={{ width: 9, height: 9, borderRadius: "50%", background: appColor(tile.status) }} />
          {(tile.url || tile.canWrite) && menuBtn}
        </div>
      </div>
      <div style={{ fontWeight: 600, fontSize: 15, marginTop: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.name}</div>
      <div style={{ fontSize: 11, color: appColor(tile.status), marginTop: 3 }}>{t(`home.status_${tile.phase}`)}</div>
      {tile.linkKind === "ip" ? (
        // A bare http://ip:port link works but isn't HTTPS — flag it and offer a one-tap secure link via the tunnel.
        <div style={{ fontSize: 11, marginTop: 4, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: "var(--c-tx3)" }}>{t("home.notSecure")}</span>
          {tile.canWrite && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onExpose(); }}
              style={{ fontWeight: 600, color: "var(--c-a)", background: "transparent", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}
            >
              {t("home.addSecureLink")}
            </button>
          )}
        </div>
      ) : tile.url ? (
        <div style={{ fontSize: 12, color: "var(--c-lapis)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
          <ExternalLink size={12} /> {t("home.open")}
        </div>
      ) : null}
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
    <a href={tile.url} target="_blank" rel="noreferrer" className="tpl-tile" style={boxStyle}>
      {inner}
    </a>
  );
}
