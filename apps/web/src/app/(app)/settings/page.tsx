"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";
import { CopyBtn } from "../../../components/copy-row";

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

      <Card style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "var(--c-tx3)", marginBottom: 4 }}>{t("settings.account")}</div>
        <div style={{ fontWeight: 600 }}>{user?.name ?? user?.email}</div>
        <div className="mono" style={{ fontSize: 12, color: "var(--c-tx3)" }}>{user?.email}</div>
      </Card>

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

function ApiTokensCard() {
  const t = useT();
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
            <button onClick={() => revoke.mutate(tk.id)} style={{ background: "transparent", border: "none", color: "var(--c-r)", fontSize: 12, cursor: "pointer" }}>
              {t("settings.revoke")}
            </button>
          </div>
        ))}
        {tokens.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("settings.noTokens")}</div>}
      </div>
    </Card>
  );
}
