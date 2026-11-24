"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Boxes, ExternalLink, MoreVertical, SlidersHorizontal, Star } from "lucide-react";
import { api, appIconUrl } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { launcherTiles, type LauncherTile } from "../../../lib/launcher";
import { loadPins, savePins, togglePin, filterTiles, sortByPins } from "../../../lib/launcher-prefs";
import { appColor } from "../../../lib/apps";
import { useT } from "../../../i18n/provider";
import { Btn, Card, EmptyState, Spinner } from "../../../components/ui";
import { Select, TextInput } from "../../../components/form";
import { ErrorState } from "../../../components/error-state";
import { ExposeModal } from "../../../components/expose-modal";
import { TileActionsSheet } from "../../../components/tile-actions-sheet";
import { RemoteAccessCard } from "../../../components/remote-access-card";
import { LiveGauges } from "../../../components/live-gauges";
import { AppLogo } from "../../../components/app-logo";
import { GaugeServerPicker, HomeWidgets } from "../../../components/home-widgets";
import { HomeCustomizePanel } from "../../../components/home-customize";
import { useUiModeSwitch } from "../../../hooks/useUiModeSwitch";
import { DEFAULT_LAYOUT, WALLPAPER_CSS, effectiveGroupMode, loadLayout, saveLayout, type HomeLayout } from "../../../lib/home-layout";
import {
  applyOrder, assignToFolder, countLabel, folderOf, groupTilesByFolder, groupTilesByTeam, homeScale, moveBefore, pickGaugeServer, suggestFleet,
} from "../../../lib/home-mode";

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
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: databases = [] } = useQuery({ queryKey: ["databases"], queryFn: () => api.listDatabases() });
  const { data: fleetLatest = [] } = useQuery({
    queryKey: ["fleetMetrics"],
    queryFn: () => api.getFleetMetrics(),
    select: (d) => (Array.isArray(d) ? d : []),
    refetchInterval: 30_000,
  });
  const switcher = useUiModeSwitch();

  // Layout (order, folders, grouping, wallpaper, widgets) is a per-browser convenience, like pins. Load after
  // mount so SSR and hydration match.
  const [layout, setLayout] = useState<HomeLayout>(DEFAULT_LAYOUT);
  useEffect(() => setLayout(loadLayout()), []);
  const patchLayout = (patch: Partial<HomeLayout>) =>
    setLayout((prev) => {
      const next = { ...prev, ...patch };
      saveLayout(next);
      return next;
    });
  const [editing, setEditing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  const allTiles = applyOrder(launcherTiles(apps), layout.order);
  const scale = homeScale(servers, teams, apps);
  // Remote access targets the home box: the auto-provisioned "This machine", else the ONE server a home
  // user has (home mode hides the Servers page, so this card is their only path to a tunnel). Never fall
  // back to an arbitrary one of several servers — that could configure a tunnel on an unrelated box.
  const remoteTarget = servers.find((s) => s.isLocal) ?? (servers.length === 1 ? servers[0] : undefined);
  // The gauges and storage/uptime widgets follow the picked server (default: this machine).
  const gaugeServer = pickGaugeServer(servers, layout.gaugeServerId);
  const gaugeSample = gaugeServer ? fleetLatest.find((r) => r.serverId === gaugeServer.id)?.sample : undefined;
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
  const tiles = allTiles;
  const visible = sortByPins(filterTiles(tiles, tiles.length > 5 ? q : ""), pins);

  const groupMode = effectiveGroupMode(layout, scale.teams);
  const teamNames = Object.fromEntries(teams.map((tm) => [tm.id, tm.name]));
  const sections: { key: string; title: string | null; subtitle?: string; empty?: string; tiles: LauncherTile[] }[] =
    groupMode === "team"
      ? groupTilesByTeam(visible, teamNames, t("home.teamFallback")).flatMap((g, _i, all) =>
          g.projects.map((p, pi) => ({
            key: p.key,
            // The team name heads its first project block; further projects of the same team add their own name.
            title: pi === 0 && (all.length > 1 || g.projects.length > 1) ? g.teamName : null,
            subtitle: g.projects.length > 1 ? (p.name ?? undefined) : undefined,
            tiles: p.tiles,
          })),
        )
      : groupMode === "folders"
        ? groupTilesByFolder(visible, layout.folders).map((g) => ({
            key: g.key,
            title: g.folder ? g.folder.name : layout.folders.length > 0 ? t("home.folderRest") : null,
            empty: g.folder && editing ? t("home.folderEmpty") : undefined,
            tiles: g.tiles,
          }))
        : [{ key: "all", title: null, tiles: visible }];

  // Drag-and-drop and the arrows both rewrite the one global order; groups just show slices of it.
  const fullOrder = allTiles.map((x) => x.id);
  const reorder = (id: string, targetId: string) => patchLayout({ order: moveBefore(fullOrder, id, targetId) });
  const shift = (list: LauncherTile[], id: string, delta: -1 | 1) => {
    const n = list[list.findIndex((x) => x.id === id) + delta];
    if (n) reorder(id, n.id);
  };
  const showHint = suggestFleet(scale) && !layout.fleetHintDismissed;

  const renderTile = (tile: LauncherTile, list: LauncherTile[]) => {
    const node = (
      <Tile key={tile.id} tile={tile} t={t} pinned={pins.has(tile.id)} editing={editing} onManage={() => setActionsFor(tile)} onExpose={() => setExposeFor(tile.id)} />
    );
    if (!editing) return node;
    const i = list.findIndex((x) => x.id === tile.id);
    const arrow = { background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: 6, width: 30, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--c-tx)" } as const;
    return (
      <div
        key={tile.id}
        draggable
        onDragStart={(e) => { setDragId(tile.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", tile.id); }}
        onDragOver={(e) => { if (dragId) e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); if (dragId) reorder(dragId, tile.id); setDragId(null); }}
        onDragEnd={() => setDragId(null)}
        style={{ opacity: dragId === tile.id ? 0.5 : 1, cursor: "grab" }}
        data-testid={`tile-${tile.id}`}
      >
        {node}
        <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
          <button style={arrow} disabled={i <= 0} aria-label={t("home.moveEarlier", { name: tile.name })} title={t("home.moveEarlier", { name: tile.name })} onClick={() => shift(list, tile.id, -1)}><ArrowLeft size={14} /></button>
          <button style={arrow} disabled={i >= list.length - 1} aria-label={t("home.moveLater", { name: tile.name })} title={t("home.moveLater", { name: tile.name })} onClick={() => shift(list, tile.id, 1)}><ArrowRight size={14} /></button>
          {layout.folders.length > 0 && (
            <Select
              value={folderOf(layout.folders, tile.id) ?? ""}
              onChange={(v) => patchLayout({ folders: assignToFolder(layout.folders, tile.id, v || null) })}
              ariaLabel={t("home.folderFor", { name: tile.name })}
              options={[{ value: "", label: t("home.noFolder") }, ...layout.folders.map((f) => ({ value: f.id, label: f.name }))]}
              style={{ padding: "5px 8px", fontSize: 12, minWidth: 0, flex: 1 }}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: "var(--page-pad)", background: WALLPAPER_CSS[layout.wallpaper], minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>{t("home.title")}</h1>
          <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: 0 }}>{t("home.subtitle")}</p>
        </div>
        <Btn variant="ghost" icon={SlidersHorizontal} aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? t("home.customizeDone") : t("home.customize")}
        </Btn>
      </div>

      {/* Home is built for one box. With several servers or teams, say so — and offer the better fit. */}
      {showHint && (
        <Card style={{ padding: 14, marginBottom: 20, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div role="status" style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{t("home.fleetHintTitle")}</div>
            <div style={{ fontSize: 12.5, color: "var(--c-tx2)", marginTop: 2 }}>
              {t("home.fleetHintBody", { servers: countLabel(t, "home.count_servers", scale.servers), teams: countLabel(t, "home.count_teams", scale.teams) })}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" onClick={() => patchLayout({ fleetHintDismissed: true })}>{t("home.fleetHintDismiss")}</Btn>
            <Btn onClick={() => void switcher.switchTo("fleet")} disabled={switcher.pending}>{t("home.fleetHintCta")}</Btn>
          </div>
        </Card>
      )}

      {editing && <HomeCustomizePanel layout={layout} onChange={patchLayout} />}

      <HomeWidgets enabled={layout.widgets} servers={servers} databases={databases} selected={gaugeServer} sample={gaugeSample} />

      {/* At-a-glance health of the picked box — CPU/RAM/disk (+temp/GPU). Hides itself until the agent reports. */}
      <GaugeServerPicker servers={servers} value={gaugeServer?.id ?? ""} onChange={(id) => patchLayout({ gaugeServerId: id })} />
      {gaugeServer && <LiveGauges id={gaugeServer.id} nowMs={Date.now()} />}

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
            sections
              .filter((sec) => sec.tiles.length > 0 || sec.empty)
              .map((sec) => (
                <section key={sec.key} aria-label={sec.title ?? undefined} style={{ marginBottom: 22 }}>
                  {sec.title && <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 4px" }}>{sec.title}</h2>}
                  {sec.subtitle && <div style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 8px" }}>{sec.subtitle}</div>}
                  {sec.tiles.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: "var(--c-tx3)" }}>{sec.empty}</div>
                  ) : (
                    <div style={{ ...grid, marginTop: sec.title || sec.subtitle ? 8 : 0 }}>{sec.tiles.map((tile) => renderTile(tile, sec.tiles))}</div>
                  )}
                </section>
              ))
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

function Tile({ tile, t, pinned, editing, onManage, onExpose }: { tile: LauncherTile; t: ReturnType<typeof useT>; pinned?: boolean; editing?: boolean; onManage: () => void; onExpose: () => void }) {
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
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--c-g)", marginTop: 5 }}>{t("home.availableAnywhere")}</div>
      )}
    </>
  );

  const boxStyle: React.CSSProperties = {
    display: "block", padding: 16, borderRadius: "var(--r2)", border: "1px solid var(--c-bd)",
    background: "var(--c-el)", textDecoration: "none", color: "var(--c-tx)",
  };

  // With a domain the whole tile launches the app; without one it's informational
  // (manage it — including adding a domain — from the ⋯ menu).
  // While customizing, tiles are drag handles — never navigate away mid-drag.
  if (!tile.url || editing) {
    return <div style={boxStyle}>{inner}</div>;
  }
  return (
    <a href={tile.url} target="_blank" rel="noreferrer" className="tpl-tile" style={boxStyle}>
      {inner}
    </a>
  );
}
