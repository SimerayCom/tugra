"use client";

import { useT } from "../../i18n/provider";
import type { Freshness, SwapBlock } from "../../lib/launch-guards";
import { Btn, LinkBtn } from "../ui";

const note = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--c-am)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } as const;

/** One literal key per reason (the key check reads literals). */
const SWAP_KEY: Record<SwapBlock, string> = {
  "unsupported-source": "migrationRun.launch.guard.swap.unsupported-source",
  "control-plane": "migrationRun.launch.guard.swap.control-plane",
  "multi-target": "migrationRun.launch.guard.swap.multi-target",
  "not-source-host": "migrationRun.launch.guard.swap.not-source-host",
};
const FRESH_KEY: Record<Freshness, string> = {
  "plan-changed": "migrationRun.launch.guard.fresh.plan-changed",
  "session-ended": "migrationRun.launch.guard.fresh.session-ended",
};

/** Why a same-server move cannot be created with these choices, and the way out. */
export function SwapBlockNote({ block, onUseOther, disabled }: { block: SwapBlock; onUseOther: () => void; disabled?: boolean }) {
  const t = useT();
  return (
    <p role="alert" data-testid="swap-block" style={note}>
      <span style={{ flex: "1 1 240px" }}>{t(SWAP_KEY[block])}</span>
      <Btn variant="ghost" onClick={onUseOther} disabled={disabled} style={{ minHeight: 44 }}>{t("migrationRun.launch.guard.useOther")}</Btn>
    </p>
  );
}

/** A copy aimed at the machine the source already runs on. */
export function SameHostNote({ names }: { names: string[] }) {
  const t = useT();
  return (
    <p role="alert" data-testid="same-host-block" style={note}>
      {t("migrationRun.launch.guard.sameHost", { names: names.join(", ") })}
    </p>
  );
}

/** A target server that already carries a live guided migration: the link opens that run. */
export function BusyNote({ name, runId }: { name: string; runId: string }) {
  const t = useT();
  return (
    <p role="alert" data-testid="busy-block" style={note}>
      <span style={{ flex: "1 1 240px" }}>{t("migrationRun.launch.guard.busy", { name })}</span>
      <LinkBtn href={`/import/runs/${encodeURIComponent(runId)}`} variant="ghost" style={{ minHeight: 44 }}>{t("migrationRun.launch.guard.busyOpen")}</LinkBtn>
    </p>
  );
}

/** What the owner reviewed is no longer true: the source moved on, or the connection ended. The button is the way out. */
export function FreshnessNote({ freshness, onRead, onConnect }: { freshness: Freshness; onRead: () => void; onConnect: () => void }) {
  const t = useT();
  return (
    <p role="alert" data-testid="fresh-block" style={note}>
      <span style={{ flex: "1 1 240px" }}>{t(FRESH_KEY[freshness])}</span>
      {freshness === "plan-changed" ? (
        <Btn variant="ghost" onClick={onRead} style={{ minHeight: 44 }}>{t("migrationRun.launch.guard.freshRead")}</Btn>
      ) : (
        <Btn variant="ghost" onClick={onConnect} style={{ minHeight: 44 }}>{t("migrationRun.launch.guard.freshConnect")}</Btn>
      )}
    </p>
  );
}
