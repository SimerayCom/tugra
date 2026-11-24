"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { Btn } from "../../../components/ui";
import { Field, TextInput } from "../../../components/form";
import type { ParsedChannelUrl } from "../../../lib/types";
import type { RoutingDraft } from "../../../lib/notification-routing";

/** Setting keys shown in the preview, each with a readable label (anything else shows its raw key). */
const SETTING_LABEL: Record<string, string> = {
  botToken: "f_botToken", chatId: "f_chatId", messageThreadId: "f_messageThreadId", webhookUrl: "f_webhookUrl", url: "f_url",
  server: "f_server", topic: "f_topic", priority: "f_priority", token: "f_token", userKey: "f_userKey", accessToken: "f_accessToken",
  homeserver: "f_homeserver", roomId: "f_roomId", user: "f_user", password: "f_password", username: "f_user", apiKey: "f_apiKey",
  routingKey: "f_routingKey", region: "f_region", email: "f_email", stream: "f_stream", deviceKey: "f_deviceKey", group: "f_group",
  number: "f_number", recipients: "f_recipients", accountSid: "f_accountSid", authToken: "f_authToken", from: "f_smsFrom", to: "f_smsTo",
};

/**
 * Add a channel from one pasted URL (Shoutrrr / Apprise style: "tgram://…", "ntfy://…", "matrix://…").
 * "Check" shows what the URL means with every credential masked; "Add" creates it. The URL is a secret, so the
 * field is never echoed back, autofilled or kept after a successful add.
 */
export function UrlSetup({ teamId, routing, eventTypes, disabled, onCreated }: { teamId: string; routing: RoutingDraft; eventTypes: string[]; disabled: boolean; onCreated: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<{ url: string; parsed: ParsedChannelUrl } | null>(null);
  const [error, setError] = useState("");

  const check = useMutation({
    mutationFn: () => api.parseChannelUrl({ teamId, url: url.trim() }),
    onSuccess: (parsed) => {
      setError("");
      setChecked({ url: url.trim(), parsed });
      setName((n) => n || parsed.suggestedName);
    },
    onError: (e) => {
      setChecked(null);
      setError((e as Error).message);
    },
  });
  const add = useMutation({
    mutationFn: () =>
      api.createChannelFromUrl({ teamId, url: url.trim(), name: name.trim() || undefined, categories: routing.categories, minSeverity: routing.minSeverity, ...(eventTypes.length ? { eventTypes } : {}) }),
    onSuccess: () => {
      setUrl("");
      setName("");
      setChecked(null);
      setError("");
      qc.invalidateQueries({ queryKey: ["channels"] });
      onCreated();
    },
    onError: (e) => setError((e as Error).message),
  });
  // An edited URL must be checked again before it can be added.
  const ready = !!checked && checked.url === url.trim();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label={t("notifications.urlLabel")} htmlFor="ch-url" hint={t("notifications.urlHint")}>
        <TextInput
          id="ch-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="tgram://…  ntfy://…  discord://…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="url"
          mono
        />
      </Field>
      <div>
        <Btn variant="ghost" onClick={() => check.mutate()} loading={check.isPending} disabled={!url.trim() || disabled || check.isPending}>
          {t("notifications.urlCheck")}
        </Btn>
      </div>

      {ready && checked && (
        <div role="status" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, background: "var(--c-el)" }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{t("notifications.urlRecognized", { type: t(`notifications.type_${checked.parsed.type}`) })}</div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(90px, max-content) 1fr", gap: "4px 12px", fontSize: 13 }}>
            {Object.entries(checked.parsed.config).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt style={{ color: "var(--c-tx3)" }}>{SETTING_LABEL[k] ? t(`notifications.${SETTING_LABEL[k]}`) : k}</dt>
                <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{v}</dd>
              </div>
            ))}
          </dl>
          <div style={{ marginTop: 12, maxWidth: 320 }}>
            <Field label={t("notifications.channelName")} htmlFor="ch-url-name">
              <TextInput id="ch-url-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <Btn onClick={() => add.mutate()} loading={add.isPending} disabled={add.isPending || disabled || !name.trim()}>
              {t("notifications.add")}
            </Btn>
          </div>
        </div>
      )}
      {error && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12 }}>{error}</div>}
    </div>
  );
}
