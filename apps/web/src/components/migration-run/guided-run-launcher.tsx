"use client";

import { useRouter } from "next/navigation";
import { Route } from "lucide-react";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { useToast } from "../toast";
import { launchPageHref, saveLaunchHandoff } from "../../lib/launch-handoff";
import { startBlock, startLabel, type StartInput } from "../../lib/launch-start";
import type { ImportApplyExtras, ImportPlan, ImportRemoteKind } from "../../lib/types";
import type { ImportScope } from "../../lib/import-scope";

export interface GuidedStartProps extends Omit<StartInput, "targetName"> {
  plan: ImportPlan;
  kind: ImportRemoteKind;
  sessionId: string;
  extras: ImportApplyExtras;
  /** The first step's choice: it travels to the launch page, which shows only what applies to it. */
  scope: ImportScope | null;
  /** Tugra server names, for "Move to <server>". */
  serverNames?: Record<string, string>;
}

/** The preview's one start action. It opens the launch PAGE (never a modal): the choices made here travel with it, and it says in one line
 *  why it is off, with a link to the place that answers it. */
export function GuidedStartAction({ props, testId, compact = false, variant = "primary" }: { props: GuidedStartProps; testId: string; compact?: boolean; variant?: "primary" | "ghost" }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const targets = new Set(Object.values(props.scope?.placed ?? {}));
  const targetName = targets.size === 1 ? props.serverNames?.[[...targets][0]] : undefined;
  const label = startLabel({ scope: props.scope, targetName });
  const block = startBlock(props);
  const go = () => {
    if (!saveLaunchHandoff({ kind: props.kind, sessionId: props.sessionId, planHash: props.plan.planHash, extras: props.extras, scope: props.scope })) {
      toast(t("migrationRun.launch.start.saveFailed"), "error");
      return;
    }
    router.push(launchPageHref(props.sessionId));
  };
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <Btn variant={variant} icon={Route} onClick={go} disabled={!!block} style={{ minHeight: 44, width: compact ? "100%" : undefined, justifyContent: "center" }}>
        {t(label.key, label.params)}
      </Btn>
      {block && (
        <p role="status" data-testid="start-why" style={{ margin: 0, fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>
          {t(block.key, block.params)}
          {block.anchor && (
            <>
              {" "}
              <a className="tg-link" href={`#${block.anchor}`}>{t("migrationRun.launch.start.why.go")}</a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** The same action pinned to the bottom of the long review, full width on a phone, so it is in reach wherever the owner stopped reading. */
export function GuidedStartBar({ props }: { props: GuidedStartProps }) {
  return (
    <div
      data-testid="guided-start-bar"
      style={{ position: "sticky", bottom: 0, zIndex: 5, padding: "10px 0 calc(10px + env(safe-area-inset-bottom, 0px))", background: "var(--c-sb)", borderTop: "1px solid var(--c-bd)" }}
    >
      <GuidedStartAction props={props} testId="guided-start-end" compact />
    </div>
  );
}
