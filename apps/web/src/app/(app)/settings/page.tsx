"use client";

import { useState } from "react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";
import { ChannelsCard } from "../../../components/channels-card";

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
    <div style={{ padding: 28, maxWidth: 520 }}>
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

      <ChannelsCard />
    </div>
  );
}
