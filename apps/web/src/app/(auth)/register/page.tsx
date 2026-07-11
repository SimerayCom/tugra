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

export default function RegisterPage() {
  const router = useRouter();
  const { reload } = useAuth();
  const t = useT();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState("");
  const [inviteTeam, setInviteTeam] = useState("");

  // Register-from-invite: pre-fill (and lock) the email to the invited address so the auto-accept
  // below matches on the server. The token comes from /invite/[token]'s "Create account" link.
  // We only enter invite mode once the preview SUCCEEDS — a bad/expired/revoked token (or a transient
  // fetch failure) must fall back to a normal registration, never leave the email locked + empty.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("invite");
    if (!token) return;
    api
      .previewInvitation(token)
      .then((p) => {
        setInvite(token);
        setEmail(p.email);
        setInviteTeam(p.teamName);
      })
      .catch(() => undefined);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.register(email, password, name || undefined);
      await reload();
      if (invite) {
        // Best-effort: land on /teams regardless; a mismatch/enforcement block leaves it pending there.
        await api.acceptInvitation(invite).catch(() => undefined);
        router.replace("/teams");
      } else {
        router.replace("/dashboard");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("auth.registerFailed"));
    }
    setBusy(false);
  };

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px" }}>{t("auth.registerTitle")}</h1>
      {inviteTeam && (
        <div style={{ fontSize: 13, color: "var(--c-tx2)", background: "color-mix(in srgb, var(--c-a) 12%, transparent)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", marginBottom: 14 }}>
          {t("auth.joiningTeam", { team: inviteTeam })}
        </div>
      )}
      <form onSubmit={submit}>
        <input style={field} placeholder={t("auth.name")} value={name} onChange={(e) => setName(e.target.value)} />
        <input
          style={{ ...field, ...(invite ? { opacity: 0.7, cursor: "not-allowed" } : {}) }}
          type="email"
          placeholder={t("auth.email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          readOnly={!!invite}
        />
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
