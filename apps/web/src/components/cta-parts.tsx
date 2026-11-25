"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useT } from "../i18n/provider";
import { blockText, capabilitiesHref, type CtaBlock } from "../lib/cta-readiness";
import { rememberImportFocus } from "../lib/import-focus";
import { MoreInfo } from "./help-link";
import { LinkBtn } from "./ui";

export const PLATFORM_NAME = { coolify: "Coolify", dokploy: "Dokploy" } as const;
export type PlatformKey = keyof typeof PLATFORM_NAME;

/** Opens the import for a source panel. The page leaves what it knows (the panel kind, the server the user came from) for the wizard; never a token. */
export function ImportLaunchBtn({ platform, serverName, variant = "ghost", label }: { platform: PlatformKey; serverName?: string; variant?: "primary" | "ghost"; label?: string }) {
  const t = useT();
  return (
    <LinkBtn href="/import" variant={variant} onClick={() => rememberImportFocus({ kind: platform, ...(serverName ? { fromServerName: serverName } : {}) })}>
      {label ?? t("servers.cta.useToken", { platform: PLATFORM_NAME[platform] })}
    </LinkBtn>
  );
}

/** Why an action is off, in words, with the fix for a missing capability one click away. */
export function BlockedNote({ block, serverId, style }: { block: CtaBlock; serverId: string; style?: CSSProperties }) {
  const t = useT();
  return (
    <span role="note" style={{ fontSize: 12, color: "var(--c-am)", ...style }}>
      {blockText(t, block)}
      {block.code === "capability" && (
        <>
          {" "}
          <Link href={capabilitiesHref(serverId)} style={{ color: "var(--c-lapis)" }}>{t("servers.cta.turnOn")}</Link>
        </>
      )}
    </span>
  );
}

/**
 * Apps a platform deployed: one line saying what is needed, the action that gets it, and the detail behind "More". Their settings are
 * stored in the platform, so a move needs its API token (the import) or, for Coolify, a read of the Coolify server.
 */
export function PlatformMoveBlock({ platform, n, serverName, readHref }: { platform: PlatformKey; n: number; serverName?: string; readHref?: string }) {
  const t = useT();
  const name = PLATFORM_NAME[platform];
  return (
    <div data-testid={`platform-move-${platform}`} style={{ display: "grid", gap: 6 }}>
      <span>{n === 1 ? t("servers.cta.platformApps_one", { platform: name }) : t("servers.cta.platformApps_other", { n, platform: name })} {t("servers.cta.platformNeeds", { platform: name })}</span>
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ImportLaunchBtn platform={platform} serverName={serverName} />
        {platform === "coolify" && (
          <LinkBtn href={readHref ?? "/import/coolify-host"} variant="ghost">{readHref ? t("servers.cta.readCoolify") : t("servers.cta.connectHub")}</LinkBtn>
        )}
      </span>
      <MoreInfo style={{ margin: 0 }}>{platform === "coolify" ? t("servers.cta.platformMore", { platform: name }) : t("servers.cta.platformMoreDokploy")}</MoreInfo>
    </div>
  );
}
