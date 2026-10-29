"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Boxes, ExternalLink, MoreVertical, Star } from "lucide-react";
import { api, appIconUrl } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { launcherTiles, type LauncherTile } from "../../../lib/launcher";
import { loadPins, savePins, togglePin, filterTiles, sortByPins } from "../../../lib/launcher-prefs";
import { appColor } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Btn, EmptyState, Spinner } from "../../../components/ui";
import { TextInput } from "../../../components/form";
import { ErrorState } from "../../../components/error-state";
import { ExposeModal } from "../../../components/expose-modal";
import { TileActionsSheet } from "../../../components/tile-actions-sheet";
import { RemoteAccessCard } from "../../../components/remote-access-card";
import { LiveGauges } from "../../../components/live-gauges";
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
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const tiles = launcherTiles(apps);
  // Remote access targets the home box: the auto-provisioned "This machine", else the ONE server a home
  // user has (home mode hides the Servers page, so this card is their only path to a tunnel). Never fall
  // back to an arbitrary one of several servers — that could configure a tunnel on an unrelated box.
  const remoteTarget = servers.find((s) => s.isLocal) ?? (servers.length === 1 ? servers[0] : undefined);
  const [exposeFor, setExposeFor] = useState<string | null>(null);
  const [actionsFor, setActionsFor] = useState<LauncherTile | null>(null);
  const [q, setQ] = useState("");
  // Pins are a per-browser convenience (localStorage). Load after mount so SSR and hydration match.
  const [pins, setPins] = useState<Set<string>>(new Set());
  useEffect(() => setPins(loadPins()), []);
  // Re-read storage at toggle time so a second tab's pins aren't clobbered (merge, not last-write-wins).
  const onTogglePin = (id: string) => {
    const next = togglePin(loadPins(), id);
    savePins(next);
    setPins(next);
  };
  // Only apply the search filter while the search box is actually shown, so a leftover query can't keep
  // filtering after the app count drops at or below the threshold (the box — and the way to clear q — is gone).
  const visible = sortByPins(filterTiles(tiles, tiles.length > 5 ? q : ""), pins);

  return (
    <div style={{ padding: "var(--page-pad)" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("home.title")}</h1>
      <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: "0 0 20px" }}>{t("home.subtitle")}</p>

      {/* At-a-glance health of the home box — CPU/RAM/disk (+temp/GPU). Hides itself until the agent reports. */}
      {remoteTarget && <LiveGauges id={remoteTarget.id} nowMs={Date.now()} />}

      {/* Only an operator who can manage the server (servers:manage) can set up a tunnel — hide it otherwise. */}
      {remoteTarget?.canWrite && <RemoteAccessCard serverId={remoteTarget.id} />}

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
        <>
          {tiles.length > 5 && (
            <div style={{ maxWidth: 360, marginBottom: 14 }}>
              <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("home.search")} aria-label={t("home.search")} />
            </div>
          )}
          {visible.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("home.noSearchMatch")}</div>
          ) : (
            <div style={grid}>
              {visible.map((tile) => (
                <Tile key={tile.id} tile={tile} t={t} pinned={pins.has(tile.id)} onManage={() => setActionsFor(tile)} onExpose={() => setExposeFor(tile.id)} />
              ))}
            </div>
          )}
        </>
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
          pinned={pins.has(actionsFor.id)}
          onTogglePin={() => onTogglePin(actionsFor.id)}
          onClose={() => setActionsFor(null)}
          onExpose={(id) => setExposeFor(id)}
        />
      )}
    </div>
  );
}

function Tile({ tile, t, pinned, onManage, onExpose }: { tile: LauncherTile; t: ReturnType<typeof useT>; pinned?: boolean; onManage: () => void; onExpose: () => void }) {
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
          <AppLogo iconUrl={appIconUrl(tile.id, tile.iconUpdatedAt)} templateSlug={tile.templateSlug} templateLogo={tile.templateLogo} source={tile.source} name={tile.name} size={26} />
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {pinned && <Star size={13} color="var(--c-a)" fill="var(--c-a)" role="img" aria-label={t("home.pinned")} />}
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
      {tile.linkKind === "tunnel" && (
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--c-g)", marginTop: 5 }}>{t("home.availableAnywhere")}</div>
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
    <a href={tile.url} target="_blank" rel="noreferrer" className="tpl-tile" style={boxStyle}>
      {inner}
    </a>
  );
}
