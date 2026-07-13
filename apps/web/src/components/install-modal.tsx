"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { autoServerId, installableServers } from "../lib/install";
import { useT } from "../i18n/provider";
import { Btn, Spinner } from "./ui";
import { Field, Select, TextInput, fieldStyle } from "./form";
import { Modal } from "./modal";
import { TemplateLogo } from "../lib/template-icons";
import { TemplateFields, validateFields } from "./template-fields";
import { useToast } from "./toast";
import type { Template } from "../lib/types";

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
  const toast = useToast();
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
    // One call: the server creates the app and kicks off a best-effort deploy.
    mutationFn: async () => {
      const nonEmpty: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (v !== "") nonEmpty[k] = v;
      const envOverride = parseEnvLines(envText);
      // Send the override whenever the content actually differs from the resolved compose — not gated
      // on the panel being open, so an edit made then collapsed is still honoured.
      const composeChanged = !!manifest?.composeFile && composeOverride !== manifest.composeFile;
      return api.createFromTemplate(template.slug, {
        name: name.trim(),
        serverId,
        deploy: true,
        ...(Object.keys(nonEmpty).length ? { fields: nonEmpty } : {}),
        ...(composeChanged ? { composeOverride } : {}),
        ...(Object.keys(envOverride).length ? { envOverride } : {}),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(t("home.installed", { name: name.trim() }), "success");
      router.push("/home");
    },
  });

  const canInstall =
    !!name.trim() && !!serverId && Object.keys(errors).length === 0 && !install.isPending && !manifestLoading;

  return (
    <Modal onClose={onClose} width={520} cardStyle={{ maxHeight: "85vh", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ width: 40, height: 40, borderRadius: 10, background: "var(--c-el)", border: "1px solid var(--c-bd)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <TemplateLogo logo={template.logo} slug={template.slug} name={template.name} size={24} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{t("home.installTitle", { name: template.name })}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis" }}>{template.description}</div>
        </div>
      </div>

      {online.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)", lineHeight: 1.5 }}>
          {t("home.noServer")}{" "}
          <Link href="/servers/new" style={{ color: "var(--c-lapis)" }}>{t("home.connectServer")}</Link>
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
        <Btn onClick={() => install.mutate()} disabled={!canInstall || online.length === 0}>
          {install.isPending ? t("home.installing") : t("home.install")}
        </Btn>
      </div>
    </Modal>
  );
}
