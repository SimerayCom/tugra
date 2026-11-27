"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useAuth } from "../../../../lib/auth";
import { useT } from "../../../../i18n/provider";
import { Btn, Card, Spinner } from "../../../../components/ui";
import { Checkbox, Field, Select } from "../../../../components/form";
import { SCOPE_OPTIONS } from "../../../(app)/settings/api-token-form";

/** Collect the first value of every query parameter (the OAuth request, sent back verbatim on the decision). */
function paramsOf(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(query).forEach((v, k) => {
    if (!(k in out)) out[k] = v;
  });
  return out;
}

/**
 * Consent screen for an MCP client's OAuth sign-in. The logged-in user sees who is asking and where the
 * browser returns, picks ONE team and the scopes to grant (limited by their role there), and allows or cancels.
 * The hub validates the client and the redirect URI on every step; this page only ever navigates to the URL the
 * hub returns.
 */
export default function OAuthAuthorizePage() {
  const t = useT();
  const router = useRouter();
  const { user, loading } = useAuth();
  const [query, setQuery] = useState<string | null>(null);
  const [teamId, setTeamId] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]); // read only: the rest is the user's call

  useEffect(() => setQuery(window.location.search.replace(/^\?/, "")), []);

  useEffect(() => {
    if (!loading && !user && query !== null) {
      router.replace(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
    }
  }, [loading, user, query, router]);

  const preview = useQuery({
    queryKey: ["oauthPreview", query],
    queryFn: () => api.oauthPreview(query!),
    enabled: !!user && !!query,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const data = preview.data;
  const team = data?.teams.find((x) => x.id === teamId);
  const allowed = useMemo(() => new Set(team?.allowedScopes ?? ["read"]), [team]);

  const pickTeam = (id: string) => {
    setTeamId(id);
    const next = data?.teams.find((x) => x.id === id);
    // A scope the new team's role does not allow is dropped here, not rejected after the click.
    setScopes((cur) => cur.filter((s) => next?.allowedScopes.includes(s)));
  };
  const toggle = (key: string, on: boolean) => setScopes((cur) => (on ? [...new Set([...cur, key])] : cur.filter((s) => s !== key)));

  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api.oauthDecision(paramsOf(query!), approve ? { approve, teamId, scopes: SCOPE_OPTIONS.map((s) => s.key).filter((k) => scopes.includes(k)) } : { approve }),
    onSuccess: (r) => window.location.assign(r.redirectTo),
  });

  if (loading || !user || query === null || preview.isLoading) {
    return <div style={{ display: "flex", justifyContent: "center", padding: 24 }}><Spinner /></div>;
  }
  if (preview.isError || !data) {
    return (
      <Card style={{ padding: 24 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>{t("oauth.invalidRequest")}</h1>
        <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: 0 }}>{t("oauth.invalidRequestHint")}</p>
      </Card>
    );
  }

  const busy = decide.isPending;
  const requested = data.requestedScopes.filter((s) => SCOPE_OPTIONS.some((o) => o.key === s));
  const scopeLabel = (key: string) => t(`settings.scope${SCOPE_OPTIONS.find((o) => o.key === key)?.stem ?? "Read"}`);

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 6px", wordBreak: "break-word" }}>{t("oauth.consentTitle", { client: data.client.name })}</h1>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 4px", wordBreak: "break-word" }}>{t("oauth.consentIntro", { client: data.client.name })}</p>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 16px", wordBreak: "break-word" }}>
        {t("oauth.returnsTo", { host: data.redirectHost })}
      </p>

      {data.teams.length === 0 ? (
        <p role="alert" style={{ fontSize: 13, color: "var(--c-r)" }}>{t("oauth.noTeams")}</p>
      ) : (
        <>
          <Field label={t("oauth.teamLabel")} hint={t("oauth.teamHint")} style={{ marginBottom: 14 }}>
            <Select
              value={teamId}
              onChange={pickTeam}
              placeholder={t("oauth.teamPlaceholder")}
              autoSelectFirst={data.teams.length === 1}
              options={data.teams.map((x) => ({ value: x.id, label: x.name }))}
            />
          </Field>

          <fieldset style={{ border: "none", padding: 0, margin: "0 0 14px" }}>
            <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", marginBottom: 5, padding: 0 }}>{t("oauth.scopesLabel")}</legend>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {SCOPE_OPTIONS.map((s) => {
                const ok = s.key === "read" || (!!team && allowed.has(s.key));
                return (
                  <div key={s.key}>
                    <Checkbox
                      checked={scopes.includes(s.key)}
                      disabled={!ok || s.key === "read"}
                      onChange={(on) => toggle(s.key, on)}
                      label={<span style={{ opacity: ok ? 1 : 0.55 }}>{t(`settings.scope${s.stem}`)}</span>}
                    />
                    <div style={{ fontSize: 11, color: "var(--c-tx3)", marginLeft: 24 }}>
                      {t(`settings.scope${s.stem}Desc`)}
                      {team && !ok && <> · {t("oauth.scopeNotAllowed")}</>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 8 }}>{t("oauth.scopesHint")}</div>
            {requested.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 4 }}>
                {t("oauth.requested", { client: data.client.name, scopes: requested.map(scopeLabel).join(", ") })}
              </div>
            )}
          </fieldset>
        </>
      )}

      {decide.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 13, marginBottom: 10 }}>{t("oauth.failed")}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn onClick={() => decide.mutate(true)} disabled={!teamId || busy} loading={busy && decide.variables === true} style={{ minHeight: 44, flex: "1 1 140px" }}>
          {t("oauth.allow")}
        </Btn>
        <Btn variant="ghost" onClick={() => decide.mutate(false)} disabled={busy} style={{ minHeight: 44, flex: "1 1 100px" }}>
          {t("oauth.cancel")}
        </Btn>
      </div>
    </Card>
  );
}
