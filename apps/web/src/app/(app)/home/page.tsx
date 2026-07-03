"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Boxes, ExternalLink } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { launcherTiles, launcherIcon, type LauncherTile } from "../../../lib/launcher";
import { appColor } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Btn, EmptyState, Spinner } from "../../../components/ui";

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
          {tiles.map((tile) => <Tile key={tile.id} tile={tile} openLabel={t("home.open")} noDomain={t("home.noDomain")} />)}
        </div>
      )}
    </div>
  );
}

function Tile({ tile, openLabel, noDomain }: { tile: LauncherTile; openLabel: string; noDomain: string }) {
  const Icon = launcherIcon(tile.source);
  const inner = (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ width: 48, height: 48, borderRadius: 12, background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon size={24} color="var(--c-a)" />
        </span>
        <span title={tile.status} style={{ width: 9, height: 9, borderRadius: "50%", background: appColor(tile.status), flexShrink: 0 }} />
      </div>
      <div style={{ fontWeight: 600, fontSize: 15, marginTop: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.name}</div>
      <div style={{ fontSize: 12, color: tile.url ? "var(--c-lapis)" : "var(--c-tx3)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
        {tile.url ? (<><ExternalLink size={12} /> {openLabel}</>) : noDomain}
      </div>
    </>
  );

  const boxStyle: React.CSSProperties = {
    display: "block", padding: 16, borderRadius: "var(--r2)", border: "1px solid var(--c-bd)",
    background: "var(--c-el)", textDecoration: "none", color: "var(--c-tx)",
  };

  if (!tile.url) {
    return <div style={{ ...boxStyle, opacity: 0.6 }}>{inner}</div>;
  }
  return (
    <a href={tile.url} target="_blank" rel="noreferrer" style={boxStyle}>
      {inner}
    </a>
  );
}
