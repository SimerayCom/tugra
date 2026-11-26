"use client";

import { useQuery } from "@tanstack/react-query";
import type { TakeoverView } from "@tugra/shared";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { takeoverIsLive, takeoverStartBlock, type TakeoverStartBlock } from "../lib/launch-guards";
import { LinkBtn } from "./ui";

/**
 * What would make the hub refuse to plan an in-place takeover of this server, from facts the screen can read now: a takeover already on it, and
 * whether Tugra's own proxy already publishes ports here. `busyRunId` is the live run that holds the server, when the caller knows one.
 * Reads only; asks nothing of the server while `enabled` is false.
 */
export function useTakeoverStartBlock(serverId: string | undefined, enabled: boolean, busyRunId: string | null = null): TakeoverStartBlock | null {
  const on = enabled && !!serverId;
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers(), enabled: on, staleTime: 15_000 });
  const takeovers = useQuery<TakeoverView[]>({ queryKey: ["coolify-inplace", serverId], queryFn: () => api.listInPlace(serverId as string), enabled: on, staleTime: 15_000, retry: false });
  const proxyBind = servers.data?.find((s) => s.id === serverId)?.proxyBind;
  // Tugra's proxy is only worth asking about when it publishes ports at all
  const proxy = useQuery({ queryKey: ["takeover-proxy", serverId], queryFn: () => api.getProxyStatus(serverId as string), enabled: on && !!proxyBind && proxyBind !== "none", staleTime: 15_000, retry: false });
  if (!on) return null;
  return takeoverStartBlock({ busyRunId, takeoverLive: (takeovers.data ?? []).some((v) => takeoverIsLive(v.status)), proxyBind, proxy: proxy.data?.status });
}

const note = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--c-am)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } as const;

/** The refusal in words, with the way to the thing that holds the server. */
export function TakeoverStartNote({ block, serverId, runId }: { block: TakeoverStartBlock; serverId: string; runId?: string | null }) {
  const t = useT();
  return (
    <p role="alert" data-testid="takeover-start-block" style={note}>
      <span style={{ flex: "1 1 240px" }}>{t(`coolifyInPlace.error.takeover_${block}`)}</span>
      {block === "server_busy" && runId ? (
        <LinkBtn href={`/import/runs/${encodeURIComponent(runId)}`} variant="ghost" style={{ minHeight: 44 }}>{t("migrationRun.launch.guard.busyOpen")}</LinkBtn>
      ) : (
        <LinkBtn href={block === "server_busy" ? `/import/inplace?serverId=${encodeURIComponent(serverId)}` : `/servers/${encodeURIComponent(serverId)}`} variant="ghost" style={{ minHeight: 44 }}>
          {t(block === "server_busy" ? "coolifyMove.takeOver.block.openTakeover" : "coolifyMove.takeOver.block.openServer")}
        </LinkBtn>
      )}
    </p>
  );
}
