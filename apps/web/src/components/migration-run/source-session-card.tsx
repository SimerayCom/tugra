"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Btn } from "../ui";
import { Field, TextInput } from "../form";
import { useRunPlumbing } from "./use-run-actions";

/** The import session lasts one hour; a run lasts hours or days. When a step needs the source again, the operator
 *  re-enters the source API token here. It goes straight into the hub's encrypted session and is never shown again. */
export function SourceSessionForm({ runId }: { runId: string }) {
  const { onError, toast, t } = useRunPlumbing(runId);
  const [token, setToken] = useState("");
  const refresh = useMutation({
    mutationFn: () => api.migrationRunSourceSession(runId, { token: token.trim() }),
    onSuccess: () => {
      setToken("");
      toast(t("migrationRun.session.refreshed"), "success");
    },
    onError,
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim() && !refresh.isPending) refresh.mutate();
      }}
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("migrationRun.session.body")}</p>
      <Field label={t("migrationRun.session.token")} hint={t("migrationRun.session.hint")}>
        <TextInput type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} style={{ minHeight: 44 }} />
      </Field>
      <div>
        <Btn type="submit" disabled={!token.trim()} loading={refresh.isPending}>{t("migrationRun.session.button")}</Btn>
      </div>
    </form>
  );
}
