"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { api, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";

const field: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 14,
  fontFamily: "inherit",
  marginBottom: 10,
};

export default function LoginPage() {
  const router = useRouter();
  const { reload } = useAuth();
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [step, setStep] = useState<"creds" | "2fa">("creds");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Surface an OAuth failure passed back from the callback (?error=…).
  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get("error");
    if (e === "oauth_unconfigured") setErr(t("auth.oauthUnconfigured"));
    else if (e) setErr(t("auth.oauthError"));
  }, [t]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const out = await api.login(email, password, step === "2fa" ? totp : undefined);
      if ("twoFaRequired" in out) {
        setStep("2fa");
      } else {
        await reload();
        router.replace("/dashboard");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("auth.loginFailed"));
    }
    setBusy(false);
  };

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px" }}>
        {step === "creds" ? t("auth.signInTitle") : t("auth.twoFaTitle")}
      </h1>
      <form onSubmit={submit}>
        {step === "creds" ? (
          <>
            <input style={field} type="email" placeholder={t("auth.email")} value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input style={field} type="password" placeholder={t("auth.password")} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </>
        ) : (
          <input style={{ ...field, letterSpacing: "0.3em", textAlign: "center" }} className="mono" placeholder="000000" value={totp} onChange={(e) => setTotp(e.target.value)} maxLength={6} autoFocus />
        )}
        {err && <div style={{ color: "var(--c-r)", fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <Btn type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : step === "creds" ? t("auth.login") : t("auth.verify")}
        </Btn>
      </form>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 12px", color: "var(--c-tx3)", fontSize: 12 }}>
        <div style={{ flex: 1, height: 1, background: "var(--c-bd)" }} />
        {t("auth.orContinueWith")}
        <div style={{ flex: 1, height: 1, background: "var(--c-bd)" }} />
      </div>
      <a href={`${API_BASE}/auth/oauth/github`} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "10px 12px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 14, fontWeight: 600, textDecoration: "none", boxSizing: "border-box" }}>
        <SiGithub size={16} /> {t("auth.signInGithub")}
      </a>
      <div style={{ marginTop: 14, fontSize: 13, color: "var(--c-tx3)", textAlign: "center" }}>
        {t("auth.noAccount")} <Link href="/register" style={{ color: "var(--c-a)" }}>{t("auth.register")}</Link>
      </div>
    </Card>
  );
}
