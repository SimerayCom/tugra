"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card, EmptyState } from "../../../components/ui";
import { Field, TextInput } from "../../../components/form";
import { CopyBtn } from "../../../components/copy-row";
import { useConfirm } from "../../../components/confirm";
import { useToast } from "../../../components/toast";

export default function SettingsPage() {
  const t = useT();
  const { user, reload } = useAuth();
  const [setup, setSetup] = useState<{ otpauthUrl: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");

  const startSetup = async () => {
    setMsg("");
    setSetup(await api.setup2fa());
  };
  const enable = async () => {
    setMsg("");
    try {
      await api.enable2fa(code);
      setSetup(null);
      setCode("");
      await reload();
      setMsg(t("settings.enabled2fa"));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t("settings.codeWrong"));
    }
  };

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 520 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 18px" }}>{t("settings.title")}</h1>

      <AccountCard />
      <PasswordCard />

      <Card style={{ padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 600 }}>{t("settings.twoFa")}</div>
            <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>
              {user?.twoFaEnabled ? t("settings.enabled") : t("settings.disabled")}
            </div>
          </div>
          {!user?.twoFaEnabled && !setup && <Btn onClick={startSetup}>{t("settings.setup")}</Btn>}
        </div>

        {setup && (
          <div style={{ marginTop: 16 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrDataUrl} alt="2FA QR" width={160} height={160} style={{ borderRadius: 8, background: "#fff", padding: 8 }} />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" maxLength={6}
                style={{ flex: 1, padding: "8px 12px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", letterSpacing: "0.2em", textAlign: "center" }} />
              <Btn onClick={enable}>{t("settings.enable")}</Btn>
            </div>
          </div>
        )}
        {msg && <div style={{ marginTop: 12, fontSize: 13, color: "var(--c-a)" }}>{msg}</div>}
      </Card>

      <ApiTokensCard />

      <Card style={{ padding: 18, marginTop: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{t("settings.channels")}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("settings.channelsDesc")}</div>
        </div>
        <Link href="/notifications"><Btn variant="ghost">{t("settings.channelsManage")}</Btn></Link>
      </Card>
    </div>
  );
}

function AccountCard() {
  const t = useT();
  const { user, reload } = useAuth();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  useEffect(() => {
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
  }, [user]);
  const save = useMutation({
    mutationFn: () => api.updateProfile({ name: name.trim() || undefined, email: email.trim() || undefined }),
    onSuccess: async () => { await reload(); toast(t("settings.profileSaved"), "success"); },
  });
  return (
    <Card style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>{t("settings.account")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label={t("settings.name")} htmlFor="acc-name">
          <TextInput id="acc-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("settings.email")} htmlFor="acc-email">
          <TextInput id="acc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <div style={{ marginTop: 14 }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending || !email.trim()}>{save.isPending ? "…" : t("settings.save")}</Btn>
      </div>
    </Card>
  );
}

function PasswordCard() {
  const t = useT();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [err, setErr] = useState("");
  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => { setCurrent(""); setNext(""); setConfirmPw(""); setErr(""); toast(t("settings.passwordChanged"), "success"); },
  });
  const submit = () => {
    setErr("");
    if (next.length < 8) { setErr(t("settings.passwordMin")); return; }
    if (next !== confirmPw) { setErr(t("settings.passwordMismatch")); return; }
    change.mutate();
  };
  return (
    <Card style={{ padding: 18, marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>{t("settings.password")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label={t("settings.currentPassword")}>
          <TextInput type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t("settings.newPassword")}>
          <TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t("settings.confirmPassword")} error={err || undefined}>
          <TextInput type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
        </Field>
      </div>
      <div style={{ marginTop: 14 }}>
        <Btn onClick={submit} disabled={change.isPending || !current || !next}>{change.isPending ? "…" : t("settings.changePassword")}</Btn>
      </div>
    </Card>
  );
}

function ApiTokensCard() {
  const t = useT();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: tokens = [] } = useQuery({ queryKey: ["apiTokens"], queryFn: () => api.listApiTokens() });
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createApiToken(name),
    onSuccess: (res) => {
      setFresh(res.token);
      setName("");
      qc.invalidateQueries({ queryKey: ["apiTokens"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteApiToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apiTokens"] }),
  });

  const field: React.CSSProperties = {
    padding: "8px 10px", background: "var(--c-el)", border: "1px solid var(--c-bd)",
    borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 13, fontFamily: "inherit",
  };

  return (
    <Card style={{ padding: 18, marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("settings.apiTokens")}</div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px" }}>{t("settings.apiTokensDesc")}</p>

      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} style={{ display: "flex", gap: 8 }}>
        <input style={{ ...field, flex: 1 }} placeholder={t("settings.tokenName")} value={name} onChange={(e) => setName(e.target.value)} required />
        <Btn onClick={() => create.mutate()} disabled={create.isPending || !name}>{t("settings.createToken")}</Btn>
      </form>

      {fresh && (
        <div style={{ marginTop: 12, padding: 10, background: "var(--c-el)", border: "1px solid var(--c-a)", borderRadius: "var(--r1)" }}>
          <div style={{ fontSize: 11, color: "var(--c-am)", marginBottom: 4 }}>{t("settings.tokenOnce")}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code className="mono" style={{ flex: 1, fontSize: 12, wordBreak: "break-all" }}>{fresh}</code>
            <CopyBtn text={fresh} label={t("settings.copy")} />
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
        {tokens.map((tk) => (
          <div key={tk.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>{tk.name}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--c-tx3)" }}>{tk.prefix}…</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>
              {tk.lastUsedAt ? `${t("settings.tokenUsed")} ${new Date(tk.lastUsedAt).toLocaleDateString()}` : t("settings.tokenUnused")}
            </span>
            <button onClick={async () => { if (await confirm({ body: t("common.deleteConfirm"), danger: true })) revoke.mutate(tk.id); }} style={{ background: "transparent", border: "none", color: "var(--c-r)", fontSize: 12, cursor: "pointer" }}>
              {t("settings.revoke")}
            </button>
          </div>
        ))}
        {tokens.length === 0 && <EmptyState icon={KeyRound} title={t("settings.noTokensTitle")}>{t("settings.noTokens")}</EmptyState>}
      </div>
    </Card>
  );
}
