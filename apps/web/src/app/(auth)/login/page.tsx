"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [step, setStep] = useState<"creds" | "2fa">("creds");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const out = await api.login(
        email,
        password,
        step === "2fa" ? totp : undefined,
      );
      if ("twoFaRequired" in out) {
        setStep("2fa");
      } else {
        await reload();
        router.replace("/dashboard");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Giriş başarısız");
    }
    setBusy(false);
  };

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px" }}>
        {step === "creds" ? "Giriş yap" : "İki adımlı doğrulama"}
      </h1>
      <form onSubmit={submit}>
        {step === "creds" ? (
          <>
            <input style={field} type="email" placeholder="E-posta" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input style={field} type="password" placeholder="Parola" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </>
        ) : (
          <input style={{ ...field, letterSpacing: "0.3em", textAlign: "center" }} className="mono" placeholder="000000" value={totp} onChange={(e) => setTotp(e.target.value)} maxLength={6} autoFocus />
        )}
        {err && <div style={{ color: "var(--c-r)", fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <Btn type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : step === "creds" ? "Giriş" : "Doğrula"}
        </Btn>
      </form>
      <div style={{ marginTop: 14, fontSize: 13, color: "var(--c-tx3)", textAlign: "center" }}>
        Hesabın yok mu? <Link href="/register" style={{ color: "var(--c-a)" }}>Kayıt ol</Link>
      </div>
    </Card>
  );
}
