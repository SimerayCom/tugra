"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Badge, Btn, Card } from "../../../components/ui";
import { Checkbox, Field, Select, TextInput } from "../../../components/form";
import type { MailProvider } from "../../../lib/types";

/**
 * Owner-only in-panel Email (SMTP / Resend) settings, so "mail not arriving" is fixed here instead of by
 * editing MAIL_* env. Provider "None" keeps the env fallback. The SMTP password / Resend key are WRITE-ONLY:
 * the stored value is never fetched — the field shows a "set" hint and is only sent when something is typed
 * (blank = keep). "Send test email" runs against the SAVED settings, so it is disabled while edits are unsaved.
 */
export function EmailSettingsCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;

  const { data } = useQuery({ queryKey: ["mailSettings"], queryFn: () => api.getMailSettings(), enabled: isOwner, refetchOnWindowFocus: false });

  const [provider, setProvider] = useState<MailProvider>("none");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [mailUser, setMailUser] = useState("");
  const [password, setPassword] = useState("");
  const [resendKey, setResendKey] = useState("");
  const [from, setFrom] = useState("");
  const [testTo, setTestTo] = useState("");
  useEffect(() => {
    if (data) {
      setProvider(data.provider);
      setHost(data.host ?? "");
      setPort(String(data.port ?? 587));
      setSecure(data.secure);
      setMailUser(data.user ?? "");
      setPassword(""); // never seeded — secrets are write-only
      setResendKey("");
      setFrom(data.from ?? "");
    }
  }, [data]);
  useEffect(() => {
    setTestTo((cur) => cur || user?.email || "");
  }, [user?.email]);

  const portNum = Number(port);
  const portValid = provider !== "smtp" || (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535);
  const needsHost = provider === "smtp" && !host.trim();
  const needsKey = provider === "resend" && !resendKey && !data?.hasResendKey;
  const canSave = portValid && !needsHost && !needsKey;

  const dirty =
    !!data &&
    (provider !== data.provider ||
      host !== (data.host ?? "") ||
      port !== String(data.port ?? 587) ||
      secure !== data.secure ||
      mailUser !== (data.user ?? "") ||
      from !== (data.from ?? "") ||
      password !== "" ||
      resendKey !== "");

  const save = useMutation({
    mutationFn: () =>
      api.updateMailSettings({
        provider,
        host: host.trim(),
        port: provider === "smtp" ? portNum : undefined,
        secure,
        user: mailUser.trim(),
        from: from.trim(),
        // Only send a secret when the owner typed one — blank keeps the stored ciphertext.
        ...(password ? { password } : {}),
        ...(resendKey ? { resendKey } : {}),
      }),
    onSuccess: (res) => {
      qc.setQueryData(["mailSettings"], res);
      qc.invalidateQueries({ queryKey: ["instanceStatus"] }); // mailConfigured flag
      setPassword("");
      setResendKey("");
      toast(t("settings.mail_saved"), "success");
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.mail_saveFailed"), "error"),
  });

  const test = useMutation({
    mutationFn: () => api.testMailSettings(testTo.trim()),
    onSuccess: (res) =>
      res.ok
        ? toast(t("settings.mail_testOk", { to: testTo.trim() }), "success")
        : toast(res.reason ? t("settings.mail_testFailed", { reason: res.reason }) : t("settings.mail_testFailedGeneric"), "error"),
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.mail_testFailedGeneric"), "error"),
  });

  if (!isOwner) return null;

  const effective = data?.effective;
  const effectiveKey = effective === "db" ? "settings.mail_effectiveDb" : effective === "env" ? "settings.mail_effectiveEnv" : "settings.mail_effectiveNone";

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600 }}>{t("settings.mail_title")}</div>
        {effective && <Badge tone={effective === "none" ? "warn" : "ok"}>{t(`settings.mail_badge_${effective}`)}</Badge>}
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 14px", lineHeight: 1.5 }}>{t("settings.mail_desc")}</p>
      {effective && <p style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 14px" }}>{t(effectiveKey)}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label={t("settings.mail_provider")} htmlFor="mail-provider">
          <Select
            id="mail-provider"
            value={provider}
            onChange={(v) => setProvider(v as MailProvider)}
            options={[
              { value: "none", label: t("settings.mail_providerNone") },
              { value: "smtp", label: t("settings.mail_providerSmtp") },
              { value: "resend", label: t("settings.mail_providerResend") },
            ]}
          />
        </Field>

        {provider === "smtp" && (
          <>
            <Field label={t("settings.mail_host")} htmlFor="mail-host">
              <TextInput id="mail-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" autoComplete="off" />
            </Field>
            <Field label={t("settings.mail_port")} htmlFor="mail-port" error={portValid ? undefined : "1–65535"}>
              <TextInput id="mail-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="587" />
            </Field>
            <Checkbox id="mail-secure" checked={secure} onChange={setSecure} label={t("settings.mail_secure")} />
            <Field label={t("settings.mail_user")} htmlFor="mail-user">
              <TextInput id="mail-user" value={mailUser} onChange={(e) => setMailUser(e.target.value)} autoComplete="off" />
            </Field>
            <Field label={t("settings.mail_password")} htmlFor="mail-password">
              <TextInput
                id="mail-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={data?.hasPassword ? t("settings.mail_secretSet") : t("settings.mail_secretUnset")}
                autoComplete="new-password"
              />
            </Field>
          </>
        )}

        {provider === "resend" && (
          <>
            <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0, lineHeight: 1.5 }}>{t("settings.mail_resendHint")}</p>
            <Field label={t("settings.mail_resendKey")} htmlFor="mail-resend-key">
              <TextInput
                id="mail-resend-key"
                type="password"
                value={resendKey}
                onChange={(e) => setResendKey(e.target.value)}
                placeholder={data?.hasResendKey ? t("settings.mail_secretSet") : "re_…"}
                autoComplete="new-password"
              />
            </Field>
          </>
        )}

        {provider !== "none" && (
          <Field label={t("settings.mail_from")} htmlFor="mail-from" hint={t("settings.mail_fromHint")}>
            <TextInput id="mail-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Tugra <no-reply@example.com>" autoComplete="off" />
          </Field>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending || !canSave || !dirty}>
          {save.isPending ? "…" : t("settings.mail_save")}
        </Btn>
      </div>

      <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--c-bd)" }}>
        <Field label={t("settings.mail_testTo")} htmlFor="mail-test-to" hint={dirty ? t("settings.mail_testNeedsSave") : undefined}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <TextInput id="mail-test-to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} autoComplete="off" />
            </div>
            <Btn variant="ghost" onClick={() => test.mutate()} disabled={test.isPending || dirty || !testTo.trim()}>
              {test.isPending ? "…" : t("settings.mail_testSend")}
            </Btn>
          </div>
        </Field>
      </div>
    </Card>
  );
}
