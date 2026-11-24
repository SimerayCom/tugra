"use client";

import { useEffect, useId, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { DB_CONFIG_FILES, DB_CONFIG_MAX_BYTES } from "../lib/databases";
import { Btn, SectionCard, Spinner } from "./ui";
import { useOptionalConfirm } from "./confirm";
import { ErrorState } from "./error-state";
import { useToast } from "./toast";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";

const area: CSSProperties = {
  width: "100%",
  minHeight: 220,
  padding: "8px 10px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  lineHeight: 1.5,
  fontFamily: "var(--font-mono, monospace)",
  boxSizing: "border-box",
  resize: "vertical",
};

const bytesOf = (s: string) => new TextEncoder().encode(s).length;

type Saved = "none" | "apply" | "first" | "cleared";

/**
 * View and edit a database's custom engine config file (owner / manager only: the parent renders it in the writer-only settings tab).
 * The text is fetched on demand (it can hold secrets, the database view only carries a presence flag), stored encrypted by the hub and
 * mounted read-only at the engine's path. Saving never touches the running container: applying is a redeploy, behind a confirmation.
 */
export function DbConfigFileCard({
  id,
  name,
  engine,
  status,
  supported,
  redeploying,
  onRedeploy,
}: {
  id: string;
  name: string;
  engine: string;
  status: string;
  supported: boolean;
  redeploying: boolean;
  onRedeploy: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useOptionalConfirm();
  const fieldId = useId();
  const def = DB_CONFIG_FILES[engine];
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["dbConfigFile", id],
    queryFn: () => api.getDatabaseConfigFile(id),
    enabled: supported,
  });
  const [draft, setDraft] = useState("");
  // The stored text the draft was seeded from: the card is dirty only against the text it loaded (or last saved).
  const [base, setBase] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved>("none");

  useEffect(() => {
    if (data && base === null) {
      setDraft(data.content ?? "");
      setBase(data.content ?? "");
    }
  }, [data, base]);

  const dirty = base !== null && draft !== base;
  useUnsavedChanges(dirty);
  const size = bytesOf(draft);
  const tooLarge = size > DB_CONFIG_MAX_BYTES;

  const save = useMutation({
    mutationFn: () => api.setDatabaseConfigFile(id, draft.trim() ? draft : null),
    onSuccess: async () => {
      const cleared = !draft.trim();
      setBase(draft);
      setSaved(status === "NEW" ? "first" : cleared ? "cleared" : "apply");
      await Promise.all([qc.invalidateQueries({ queryKey: ["dbConfigFile", id] }), qc.invalidateQueries({ queryKey: ["database", id] })]);
    },
    onError: () => toast(t("databases.configFileSaveFailed"), "error"),
  });

  if (!supported || !def) return null;

  const redeploy = async () => {
    const ok = confirm
      ? await confirm({ title: t("databases.configFileRedeployTitle", { name }), body: t("databases.configFileRedeployBody"), confirmLabel: t("databases.configFileRedeployConfirm") })
      : true;
    if (!ok) return;
    setSaved("none");
    onRedeploy();
  };

  return (
    <SectionCard title={t("databases.configFileTitle")} desc={t("databases.configFileDesc")} style={{ marginBottom: 0 }}>
      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label htmlFor={fieldId} style={{ fontSize: 12, color: "var(--c-tx2)" }}>
            {t("databases.configFilePath", { path: def.path })}
          </label>
          <textarea
            id={fieldId}
            style={area}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSaved("none");
            }}
            placeholder={t("databases.configFilePlaceholder")}
            aria-label={t("databases.configFileLabel")}
            aria-describedby={`${fieldId}-hint`}
            aria-invalid={tooLarge}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
          />
          <div id={`${fieldId}-hint`} style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--c-tx3)" }}>
            <span>{t(`databases.configFileHint${def.hint}`)}</span>
            <span style={tooLarge ? { color: "var(--c-r)" } : undefined}>
              {tooLarge ? t("databases.configFileTooLarge", { max: DB_CONFIG_MAX_BYTES / 1024 }) : t("databases.configFileSize", { used: (size / 1024).toFixed(1), max: DB_CONFIG_MAX_BYTES / 1024 })}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Btn onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || tooLarge}>
              {t("databases.configFileSave")}
            </Btn>
            {(saved === "apply" || saved === "cleared") && status !== "NEW" && (
              <Btn variant="ghost" onClick={() => void redeploy()} loading={redeploying}>
                {t("databases.configFileRedeploy")}
              </Btn>
            )}
            {dirty && (
              <span role="status" style={{ fontSize: 12, color: "var(--c-am)" }}>
                {t("databases.configFileUnsaved")}
              </span>
            )}
          </div>
          {saved !== "none" && !dirty && (
            <div role="status" style={{ fontSize: 12, color: "var(--c-am)" }}>
              {saved === "first" ? t("databases.configFileSavedFirst") : saved === "cleared" ? t("databases.configFileSavedCleared") : t("databases.configFileSavedApply")}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
