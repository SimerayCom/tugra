"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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

export default function RegisterPage() {
  const router = useRouter();
  const { reload } = useAuth();
  const t = useT();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.register(email, password, name || undefined);
      await reload();
      router.replace("/dashboard");
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("auth.registerFailed"));
    }
    setBusy(false);
  };

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px" }}>{t("auth.registerTitle")}</h1>
      <form onSubmit={submit}>
        <input style={field} placeholder={t("auth.name")} value={name} onChange={(e) => setName(e.target.value)} />
        <input style={field} type="email" placeholder={t("auth.email")} value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input style={field} type="password" placeholder={t("auth.passwordMin")} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        {err && <div style={{ color: "var(--c-r)", fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <Btn type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : t("auth.createAccount")}
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
        {t("auth.haveAccount")} <Link href="/login" style={{ color: "var(--c-a)" }}>{t("auth.login")}</Link>
      </div>
    </Card>
  );
}
