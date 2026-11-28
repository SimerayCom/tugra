"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Btn } from "../ui";
import { runQueryKey, sessionQueryKey, useRunPlumbing } from "./use-run-actions";

/**
 * A run whose source is read through the agent has no token to re-enter. When its import session ended, one click asks the hub to read
 * Coolify again through the same agent and Coolify team the run was made for. The hub binds the new session to the run only while the source
 * is still the one the run was planned on; otherwise it answers that the plan changed and nothing is bound.
 */
export function AgentSessionReconnect({ runId }: { runId: string }) {
  const { onError, toast, t } = useRunPlumbing(runId);
  const qc = useQueryClient();
  const reconnect = useMutation({
    mutationFn: () => api.migrationRunSourceSession(runId, { agent: true }),
    onSuccess: (r) => {
      qc.setQueryData(sessionQueryKey(runId), { sessionId: r.sessionId, expiresAt: r.expiresAt });
      void qc.invalidateQueries({ queryKey: runQueryKey(runId) });
      toast(t("migrationRun.session.reconnected"), "success");
    },
    onError,
  });
  return (
    <div data-testid="agent-session-reconnect" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("migrationRun.session.agentBody")}</p>
      <div>
        <Btn onClick={() => reconnect.mutate()} loading={reconnect.isPending} style={{ minHeight: 44 }}>
          {t("migrationRun.session.agentButton")}
        </Btn>
      </div>
    </div>
  );
}
