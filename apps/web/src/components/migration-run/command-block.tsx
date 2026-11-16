"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { CopyBtn } from "../copy-row";
import { formatDuration } from "../../lib/import";
import { secondsUntil } from "../../lib/migration-run";
import type { MigrationRunCommandResult, MigrationRunStepKey } from "../../lib/types";
import { useRunPlumbing } from "./use-run-actions";

const codeBox: React.CSSProperties = {
  margin: 0,
  padding: "10px 12px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  overflowWrap: "anywhere",
};

/** The exact source-host command of an operator step. The hub mints the migration token when the operator asks and
 *  returns the command ONCE: this block holds it in memory only (a reload drops it; "Issue again" mints a new one). */
export function CommandBlock({ runId, stepKey }: { runId: string; stepKey: MigrationRunStepKey }) {
  const { onError, t } = useRunPlumbing(runId);
  const [result, setResult] = useState<MigrationRunCommandResult | null>(null);
  const mint = useMutation({
    mutationFn: (reissue: boolean) => api.migrationRunCommand(runId, stepKey, { reissue }),
    onSuccess: setResult,
    onError,
  });
  const left = result ? secondsUntil(result.expiresAt, Date.now()) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("migrationRun.command.intro")}</p>
      {!result ? (
        <div>
          <Btn onClick={() => mint.mutate(false)} loading={mint.isPending}>{t("migrationRun.command.get")}</Btn>
        </div>
      ) : (
        <>
          <div role="note" style={{ fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>
            {t("migrationRun.command.shownOnce")}
            {left !== null && <> {t("migrationRun.command.expires", { time: formatDuration(left) ?? "0 s" })}</>}
          </div>
          <CommandRow label={t("migrationRun.command.bootstrap")} text={result.command} />
          {result.commands && (
            <>
              <CommandRow label={t("migrationRun.command.inspect")} text={result.commands.dryRun} />
              <CommandRow label={t("migrationRun.command.copy")} text={result.commands.run} />
              <CommandRow label={t("migrationRun.command.resume")} text={result.commands.resume} />
            </>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={() => mint.mutate(true)} loading={mint.isPending}>{t("migrationRun.command.reissue")}</Btn>
            <Btn variant="ghost" onClick={() => setResult(null)}>{t("migrationRun.command.hide")}</Btn>
          </div>
        </>
      )}
    </div>
  );
}

function CommandRow({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", flex: 1, minWidth: 120 }}>{label}</span>
        <CopyBtn text={text} />
      </div>
      <pre className="mono" style={codeBox}>{text}</pre>
    </div>
  );
}
