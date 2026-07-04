"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Boxes, ExternalLink, Plus } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { launcherTiles, type LauncherTile } from "../../../lib/launcher";
import { appColor } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Btn, EmptyState, Spinner } from "../../../components/ui";
import { SetDomainModal } from "../../../components/set-domain-modal";
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
            <Tile key={tile.id} tile={tile} openLabel={t("home.open")} addDomain={t("home.addDomain")} onAddDomain={() => setAddDomainFor(tile.id)} />
          ))}
        </div>
      )}

      {addDomainFor && <SetDomainModal appId={addDomainFor} onClose={() => setAddDomainFor(null)} />}
    </div>
  );
}

function Tile({ tile, openLabel, addDomain, onAddDomain }: { tile: LauncherTile; openLabel: string; addDomain: string; onAddDomain: () => void }) {
  const inner = (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ width: 48, height: 48, borderRadius: 12, background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <AppLogo templateSlug={tile.templateSlug} templateLogo={tile.templateLogo} source={tile.source} name={tile.name} size={26} />
        </span>
        <span title={tile.status} style={{ width: 9, height: 9, borderRadius: "50%", background: appColor(tile.status), flexShrink: 0 }} />
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

  // No domain → not openable; offer to add one so it becomes a launch tile.
  if (!tile.url) {
    return (
      <div style={boxStyle}>
        {inner}
        <button
          onClick={onAddDomain}
          style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--c-tx3)", fontSize: 12, fontFamily: "inherit" }}
        >
          <Plus size={12} /> {addDomain}
        </button>
      </div>
    );
  }
  return (
    <a href={tile.url} target="_blank" rel="noreferrer" style={boxStyle}>
      {inner}
    </a>
  );
}
