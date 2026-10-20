"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { KeyRound } from "lucide-react";
import { api, ApiError } from "../../../lib/api";
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
  const { reload, initialized, user } = useAuth();
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [step, setStep] = useState<"creds" | "2fa">("creds");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState("");
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(false);

  // Surface an OAuth/SSO failure passed back from the callback (?error=…) and capture an invite token
  // (from /invite/[token]'s "Sign in" link) to auto-accept after login.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const e = params.get("error");
    if (e === "oauth_unconfigured") setErr(t("auth.oauthUnconfigured"));
    else if (e === "sso_unconfigured") setErr(t("auth.ssoUnconfigured"));
    else if (e) setErr(t("auth.oauthError"));
    setInvite(params.get("invite") ?? "");
  }, [t]);

  // Only offer the SSO / GitHub buttons when the instance has it enabled + configured (Pro). Fail-soft: a status
  // error just hides the button (password login still works).
  useEffect(() => {
    api.getInstanceStatus().then((s) => {
        // authProviders.oidc = configured; ssoEnabled = enabled + configured + licensed. Require both.
        setSsoEnabled(s.ssoEnabled && (s.authProviders ? s.authProviders.oidc : true));
        setGithubEnabled(!!s.authProviders?.github);
      })
      .catch(() => undefined);
  }, []);

  // A fresh install has no account to sign into — forward to the welcome/onboarding flow. Loop-safe:
  // /welcome only bounces back here once initialized === true.
  useEffect(() => {
    if (initialized === false && !user) router.replace("/welcome");
  }, [initialized, user, router]);

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
        if (invite) {
          await api.acceptInvitation(invite).catch(() => undefined);
          router.replace("/teams");
        } else {
          router.replace("/dashboard");
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) setErr(t("auth.locked"));
      else if (e instanceof ApiError && e.status === 429) setErr(t("auth.tooMany"));
      else setErr(e instanceof Error ? e.message : t("auth.loginFailed"));
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
          <>
            <input style={{ ...field, letterSpacing: "0.2em", textAlign: "center", marginBottom: 6 }} className="mono" placeholder="000000" value={totp} onChange={(e) => setTotp(e.target.value)} maxLength={14} autoFocus />
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>{t("auth.recoveryHint")}</div>
          </>
        )}
        {err && <div style={{ color: "var(--c-r)", fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <Btn type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : step === "creds" ? t("auth.login") : t("auth.verify")}
        </Btn>
      </form>
      {(githubEnabled || ssoEnabled) && (
        <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 12px", color: "var(--c-tx3)", fontSize: 12 }}>
        <div style={{ flex: 1, height: 1, background: "var(--c-bd)" }} />
        {t("auth.orContinueWith")}
        <div style={{ flex: 1, height: 1, background: "var(--c-bd)" }} />
      </div>
        </>
      )}
      {githubEnabled && (
        <>
      {/* OAuth start is exempt from the hub's /api/v1 prefix (its callback is registered externally); a
          dedicated next.config rewrite proxies this bare path to the hub, so DON'T route it via API_BASE. */}
      <a href="/api/auth/oauth/github" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "10px 12px", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 14, fontWeight: 600, textDecoration: "none", boxSizing: "border-box" }}>
        <SiGithub size={16} /> {t("auth.signInGithub")}
      </a>
        </>
      )}
      {/* SSO start is exempt from the /api/v1 prefix (its callback is registered with the IdP); a dedicated
          next.config rewrite proxies this bare path to the hub. Shown only when the instance enables SSO. */}
      {ssoEnabled && (
        <a href="/api/auth/oidc" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "10px 12px", marginTop: 10, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontSize: 14, fontWeight: 600, textDecoration: "none", boxSizing: "border-box" }}>
          <KeyRound size={16} /> {t("auth.signInSso")}
        </a>
      )}
      <div style={{ marginTop: 14, fontSize: 13, color: "var(--c-tx3)", textAlign: "center" }}>
        {t("auth.noAccount")} <Link href="/register" style={{ color: "var(--c-a)" }}>{t("auth.register")}</Link>
        <span style={{ margin: "0 8px", opacity: 0.4 }}>·</span>
        <Link href="/forgot-password" style={{ color: "var(--c-a)" }}>{t("auth.forgotLink")}</Link>
      </div>
    </Card>
  );
}
