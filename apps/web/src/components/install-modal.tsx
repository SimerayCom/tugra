"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { autoServerId, installableServers } from "../lib/install";
import { installPhase } from "../lib/install-progress";
import { useT } from "../i18n/provider";
import { Btn, Spinner } from "./ui";
import { Field, Select, TextInput, fieldStyle } from "./form";
import { Modal } from "./modal";
import { TemplateLogo } from "../lib/template-icons";
import { TemplateFields, validateFields } from "./template-fields";
import type { Application, Template } from "../lib/types";

/** Parse a KEY=VALUE-per-line textarea into an env record (blank lines / `#` comments skipped). */
function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq > 0) out[s.slice(0, eq).trim()] = s.slice(eq + 1);
  }
  return out;
}

/**
 * Home-mode install: name + (auto) server + typed manifest fields → create app + best-effort deploy.
 * The field DEFINITIONS come from the secret-safe manifest endpoint; resolution (secrets, ports,
 * hosts) happens server-side. Blank generate-backed fields are elided so the server fills them.
 */
export function InstallModal({ template, onClose }: { template: Template; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();

  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const online = installableServers(servers);
  const [name, setName] = useState(template.name);
  const [serverId, setServerId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const [composeOverride, setComposeOverride] = useState("");
  const [envText, setEnvText] = useState("");
  // Once the app is created, the modal switches from the form to a live install-progress view.
  const [created, setCreated] = useState<Application | null>(null);

  // Servers load async; auto-pick the sole online server once they arrive.
  useEffect(() => {
    if (!serverId) {
      const auto = autoServerId(servers);
      if (auto) setServerId(auto);
    }
  }, [servers, serverId]);

  // Manifest = field DEFINITIONS (no secret values) + exposure; the raw composeFile is included only
  // once a server is chosen and the caller can write to its team. Re-fetch when the server changes.
  const { data: manifest, isLoading: manifestLoading, isError: manifestError } = useQuery({
    queryKey: ["templateManifest", template.slug, serverId],
    queryFn: () => api.getTemplateManifest(template.slug, serverId || undefined),
    enabled: online.length > 0,
  });
  const fields = manifest?.fields ?? [];

  // Seed each field's declared default into the form once the manifest arrives, without clobbering a
  // value the user has already set — so a defaulted field renders with its value (and a defaulted
  // boolean shows checked) instead of appearing blank yet deploying as its default.
  useEffect(() => {
    if (!manifest?.fields) return;
    setValues((prev) => {
      let next = prev;
      for (const f of manifest.fields!) {
        if (f.default != null && f.default !== "" && !(f.key in next)) {
          next = next === prev ? { ...prev } : next;
          next[f.key] = f.default;
        }
      }
      return next;
    });
  }, [manifest?.fields]);

  // Prefill the advanced compose editor once the resolved compose arrives (only if untouched).
  useEffect(() => {
    if (manifest?.composeFile && composeOverride === "") setComposeOverride(manifest.composeFile);
  }, [manifest?.composeFile, composeOverride]);

  const errors = useMemo(() => validateFields(values, fields, t), [values, fields, t]);

  const install = useMutation({
    // One call: the server creates the app and, when `deploy`, kicks off a best-effort deploy.
    // deploy=false creates a NEW (draft) app and lands on its Configuration tab to review first.
    mutationFn: async (deploy: boolean) => {
      const nonEmpty: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (v !== "") nonEmpty[k] = v;
      const envOverride = parseEnvLines(envText);
      // Send the override whenever the content actually differs from the resolved compose — not gated
      // on the panel being open, so an edit made then collapsed is still honoured.
      const composeChanged = !!manifest?.composeFile && composeOverride !== manifest.composeFile;
      return api.createFromTemplate(template.slug, {
        name: name.trim(),
        serverId,
        deploy,
        ...(Object.keys(nonEmpty).length ? { fields: nonEmpty } : {}),
        ...(composeChanged ? { composeOverride } : {}),
        ...(Object.keys(envOverride).length ? { envOverride } : {}),
      });
    },
    onSuccess: async (app, deploy) => {
      await qc.invalidateQueries({ queryKey: ["apps"], exact: true });
      if (deploy) {
        // Keep the modal open and switch to a live progress view so the user watches it come up.
        setCreated(app);
      } else {
        // Draft (not deployed). This modal is the HOME launcher's install flow, and /apps/:id is a fleet
        // route the Home layout would bounce — so land on the launcher, where the new (stopped) tile shows
        // and can be started/managed from its tile menu. No dead-end redirect.
        onClose();
        router.push("/home");
      }
    },
  });

  const canInstall =
    !!name.trim() && !!serverId && Object.keys(errors).length === 0 && !install.isPending && !manifestLoading;

  return (
    <Modal onClose={onClose} width={520} ariaLabel={t("home.installTitle", { name: template.name })} cardStyle={{ maxHeight: "85vh", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ width: 40, height: 40, borderRadius: 10, background: "var(--c-el)", border: "1px solid var(--c-bd)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <TemplateLogo logo={template.logo} slug={template.slug} name={template.name} size={24} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{t("home.installTitle", { name: template.name })}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis" }}>{template.description}</div>
        </div>
      </div>

      {created ? (
        <InstallProgress app={created} name={name.trim()} onClose={onClose} />
      ) : (
      <>
      {online.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)", lineHeight: 1.5 }}>
          {t("home.noServer")}{" "}
          {/* Home-allowed path to add a server: the onboarding add-server step (fleet /servers/new would bounce). */}
          <Link href="/welcome?step=add-first-server" style={{ color: "var(--c-lapis)" }}>{t("home.connectServer")}</Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label={t("home.appName")} htmlFor="install-name">
            <TextInput id="install-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {online.length > 1 && (
            <Field label={t("home.chooseServer")} htmlFor="install-server">
              <Select
                id="install-server"
                value={serverId}
                onChange={setServerId}
                options={online.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
          )}

          {manifestLoading ? (
            <div style={{ display: "flex", justifyContent: "center", padding: 12 }}><Spinner /></div>
          ) : (
            <>
              {manifestError && (
                <div style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.4 }}>{t("templates.manifestError")}</div>
              )}
              <TemplateFields
                fields={fields}
                values={values}
                errors={errors}
                onChange={(key, v) => setValues((p) => ({ ...p, [key]: v }))}
              />
            </>
          )}

          {/* Fork-free advanced override — only when the server context returns the compose. */}
          {manifest?.composeFile && (
            <div>
              <button
                type="button"
                onClick={() => setAdvanced((v) => !v)}
                style={{ background: "none", border: "none", color: "var(--c-lapis)", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}
              >
                {advanced ? "▾ " : "▸ "}{t("templates.advanced")}
              </button>
              {advanced && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
                  <Field label={t("templates.composeLabel")}>
                    <textarea
                      value={composeOverride}
                      onChange={(e) => setComposeOverride(e.target.value)}
                      spellCheck={false}
                      style={{ ...fieldStyle, minHeight: 160, fontFamily: "var(--font-mono, monospace)", fontSize: 12, resize: "vertical" }}
                    />
                  </Field>
                  <Field label={t("templates.envOverrideLabel")} hint={t("templates.envOverrideHint")}>
                    <textarea
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                      placeholder="KEY=VALUE"
                      spellCheck={false}
                      style={{ ...fieldStyle, minHeight: 70, fontFamily: "var(--font-mono, monospace)", fontSize: 12, resize: "vertical" }}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, alignItems: "center" }}>
        {install.isError && (
          <span style={{ color: "var(--c-r)", fontSize: 12, marginRight: "auto", overflowWrap: "anywhere" }}>
            {(install.error as Error).message}
          </span>
        )}
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn variant="ghost" onClick={() => install.mutate(true)} disabled={!canInstall || online.length === 0}>
          {t("home.installDeploy")}
        </Btn>
        <Btn onClick={() => install.mutate(false)} disabled={!canInstall || online.length === 0}>
          {install.isPending ? t("home.installing") : t("home.installConfigure")}
        </Btn>
      </div>
      </>
      )}
    </Modal>
  );
}

/**
 * Live install-progress view: polls the just-created app until it is running or failed, turning a
 * one-click install into a "installing → ready, Open" moment. On failure it shows a short log tail and a Retry.
 */
// An <a> styled like a primary Btn — a real link (keyboard/middle-click/new-tab all work) without nesting a
// <button> inside an <a> (invalid). Mirrors Btn's primary look.
const openLinkBtn: React.CSSProperties = {
  fontFamily: "inherit", fontSize: 13, fontWeight: 600, padding: "8px 14px", borderRadius: "var(--r1)",
  border: "1px solid transparent", background: "var(--c-a)", color: "var(--c-on-a)", textDecoration: "none",
  display: "inline-flex", alignItems: "center", gap: 6,
};
const POLL_CAP_MS = 10 * 60_000; // give a slow deploy up to ~10 min before showing a "taking longer" fallback

function InstallProgress({ app, name, onClose }: { app: Application; name: string; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [expired, setExpired] = useState(false);

  // Client-side cap: a deploy that never reaches RUNNING/FAILED can't poll forever.
  useEffect(() => {
    const id = setTimeout(() => setExpired(true), POLL_CAP_MS);
    return () => clearTimeout(id);
  }, []);

  const { data: live } = useQuery({
    queryKey: ["apps", app.id],
    queryFn: () => api.getApp(app.id),
    initialData: app,
    refetchInterval: (q) => {
      const s = (q.state.data as Application | undefined)?.status;
      if (q.state.status === "error") return false; // stop hammering a 404/401/etc — show the error state
      if (s === "RUNNING") return false; // ready → stop
      if (expired) return false; // gave it long enough
      if (s === "FAILED" && !retrying) return false; // rest on the failure screen until the user retries
      return 3000; // installing, or failed right after a retry
    },
  });
  const phase = installPhase(live?.status);

  // Reflect a finished (or re-deployed-to-running) app in the launcher list.
  useEffect(() => {
    if (phase === "running") qc.invalidateQueries({ queryKey: ["apps"], exact: true });
  }, [phase, qc]);
  // A retry's redeploy moving the app off FAILED ends the retry cycle.
  useEffect(() => {
    if (phase !== "failed") setRetrying(false);
  }, [phase]);

  const retry = useMutation({
    mutationFn: () => api.deployApp(app.id),
    onSuccess: () => {
      setRetrying(true); // re-enable polling so the new deploy's progress shows
      qc.invalidateQueries({ queryKey: ["apps", app.id, "logs"] }); // refresh the stale log tail
    },
  });
  const { data: logs } = useQuery({
    queryKey: ["apps", app.id, "logs"],
    queryFn: () => api.getAppLogs(app.id, 40),
    enabled: phase === "failed",
  });

  const goHome = () => { onClose(); router.push("/home"); };
  const center: React.CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "20px 8px", textAlign: "center" };

  // Cap reached while still coming up → stop spinning, point the user at Home.
  if (expired && phase === "installing") {
    return (
      <div role="status" aria-live="polite" style={center}>
        <div style={{ fontWeight: 600 }}>{t("home.installProgressSlow", { name })}</div>
        <Btn variant="ghost" onClick={goHome}>{t("home.installGoHome")}</Btn>
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite" style={center}>
      {phase === "installing" && (
        <>
          <Spinner />
          <div style={{ fontWeight: 600 }}>{t("home.installProgressInstalling", { name })}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("home.installProgressWait")}</div>
          <Btn variant="ghost" onClick={goHome}>{t("home.installGoHome")}</Btn>
        </>
      )}
      {phase === "running" && (
        <>
          <CheckCircle2 size={40} color="var(--c-g)" aria-hidden />
          <div style={{ fontWeight: 600 }}>{t("home.installProgressReady", { name })}</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
            {live?.url && <a href={live.url} target="_blank" rel="noreferrer" style={openLinkBtn}>{t("home.open")}</a>}
            <Btn variant="ghost" onClick={goHome}>{t("home.installGoHome")}</Btn>
          </div>
        </>
      )}
      {phase === "failed" && (
        <>
          <XCircle size={40} color="var(--c-r)" aria-hidden />
          <div style={{ fontWeight: 600 }}>{t("home.installProgressFailed", { name })}</div>
          {logs?.output && (
            <pre tabIndex={0} aria-label={t("home.installLogs")} style={{ width: "100%", maxHeight: 160, overflow: "auto", textAlign: "left", fontSize: 11, lineHeight: 1.4, background: "var(--c-bg)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {logs.output.slice(-2000)}
            </pre>
          )}
          {retry.isError && <div style={{ color: "var(--c-r)", fontSize: 12 }}>{(retry.error as Error).message}</div>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
            <Btn onClick={() => retry.mutate()} disabled={retry.isPending}>{retry.isPending ? t("home.installRetrying") : t("home.installRetry")}</Btn>
            <Btn variant="ghost" onClick={goHome}>{t("home.installGoHome")}</Btn>
          </div>
        </>
      )}
    </div>
  );
}
