"use client";

import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Btn } from "../ui";
import { useConfirm } from "../confirm";
import type { MigrationRunView } from "../../lib/types";
import { useRunPlumbing } from "./use-run-actions";

/**
 * "Give Coolify back" on an in-place run: Tugra stops and Coolify serves the sites again, nothing is lost. It is the run's abort (the hub
 * puts every change back), asked with one short question instead of typing the run's id: the id is not a secret, the question is the guard.
 * Offered only while the hub allows an abort.
 */
export function GiveBackButton({ run, variant = "ghost" }: { run: MigrationRunView; variant?: "ghost" | "dangerGhost" }) {
  const { adopt, onError, t } = useRunPlumbing(run.id);
  const confirm = useConfirm();
  const abort = useMutation({ mutationFn: () => api.abortMigrationRun(run.id, { confirmName: run.id }), onSuccess: adopt, onError });
  if (!run.allowed.abort) return null;
  const onClick = async () => {
    if (await confirm({ title: t("inPlaceRun.giveBack.title"), body: t("inPlaceRun.giveBack.body"), confirmLabel: t("inPlaceRun.giveBack.confirm") })) abort.mutate();
  };
  return (
    <Btn variant={variant} onClick={onClick} loading={abort.isPending}>
      {t("inPlaceRun.giveBack.button")}
    </Btn>
  );
}
