"use client";

import Link from "next/link";
import { useT } from "../../i18n/provider";
import type { SourceAgentGap } from "../../lib/coolify-ssh";

/**
 * "A move needs a Tugra agent on both servers": the source servers that have none, and how to add one. Over Coolify's own SSH keys in one click
 * when the Coolify host is connected through its agent, otherwise with the install command, a cloud console or cloud-init. A dry run still
 * works; a real run starts when every source server has an agent. `href` is the Coolify page of the host the source is read through, when known.
 */
export function AgentGapNotice({ gaps, dryRun, href = "/import/coolify-host" }: { gaps: readonly SourceAgentGap[]; dryRun: boolean; href?: string }) {
  const t = useT();
  if (gaps.length === 0) return null;
  return (
    <div role="alert" data-testid="agent-gap" style={{ border: "1px solid var(--c-am)", borderRadius: "var(--r1)", padding: 12, display: "grid", gap: 6, fontSize: 12, lineHeight: 1.5 }}>
      <strong style={{ fontSize: 13 }}>{t("coolifyInstall.gap.title")}</strong>
      <span style={{ color: "var(--c-tx2)" }}>{t("coolifyInstall.gap.body")}</span>
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
        {gaps.map((g) => (
          <li key={g.ref}>
            {g.name} <span style={{ color: "var(--c-tx3)" }}>({t(`coolifyInstall.gap.${g.state}`)})</span>
          </li>
        ))}
      </ul>
      <span style={{ color: "var(--c-tx3)" }}>{t("coolifyInstall.gap.sshHint")}</span>
      <span style={{ color: "var(--c-tx3)" }}>{t("coolifyInstall.gap.commandHint")}</span>
      {dryRun && <span style={{ color: "var(--c-tx3)" }}>{t("coolifyInstall.gap.dryRunNote")}</span>}
      <Link href={href} style={{ color: "var(--c-lapis)", minHeight: 44, display: "inline-flex", alignItems: "center" }}>
        {t("coolifyInstall.gap.link")}
      </Link>
    </div>
  );
}
