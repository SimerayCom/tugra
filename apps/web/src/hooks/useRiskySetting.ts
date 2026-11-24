"use client";

import { useCallback } from "react";
import { useConfirm, type ConfirmOptions } from "../components/confirm";
import { useToast } from "../components/toast";
import { useT } from "../i18n/provider";

/** One change to a setting that is easy to click by mistake or annoying to reverse by hand. */
export interface RiskySettingChange {
  /** When true the user must confirm first; when false the change applies at once (the undo toast still shows). */
  risky: boolean;
  /** The confirmation dialog (title/body/button). Only used when `risky`. */
  confirm?: ConfirmOptions;
  /** Performs the change. A rejection is surfaced as an error toast and nothing else happens. */
  apply: () => Promise<unknown>;
  /** Puts the previous value back; wired to the one-click Undo on the success toast. */
  undo: () => Promise<unknown>;
  doneMessage: string;
  undoneMessage: string;
}

/** How long the Undo stays on screen — long enough to notice a mis-click, short enough not to nag. */
export const UNDO_WINDOW_MS = 10_000;

/**
 * Shared pattern for risky settings: a short confirmation (only when the change is risky), then a toast with a
 * one-click Undo. Resolves true when the change was applied, false when the user cancelled or it failed.
 */
export function useRiskySetting(): (change: RiskySettingChange) => Promise<boolean> {
  const confirm = useConfirm();
  const toast = useToast();
  const t = useT();
  return useCallback(
    async (change) => {
      if (change.risky && !(await confirm(change.confirm))) return false;
      try {
        await change.apply();
      } catch (err) {
        toast(err instanceof Error && err.message ? err.message : t("common.somethingWentWrong"), "error");
        return false;
      }
      toast(change.doneMessage, "success", {
        durationMs: UNDO_WINDOW_MS,
        action: {
          label: t("common.undo"),
          onClick: () => {
            change
              .undo()
              .then(() => toast(change.undoneMessage, "success"))
              .catch((err) => toast(err instanceof Error && err.message ? err.message : t("common.somethingWentWrong"), "error"));
          },
        },
      });
      return true;
    },
    [confirm, toast, t],
  );
}
