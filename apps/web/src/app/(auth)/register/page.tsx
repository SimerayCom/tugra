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

export default function RegisterPage() {
  const router = useRouter();
  const { reload } = useAuth();
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
      setErr(e instanceof Error ? e.message : "Kayıt başarısız");
    }
    setBusy(false);
  };

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px" }}>Kayıt ol</h1>
      <form onSubmit={submit}>
        <input style={field} placeholder="İsim (opsiyonel)" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={field} type="email" placeholder="E-posta" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input style={field} type="password" placeholder="Parola (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        {err && <div style={{ color: "var(--c-r)", fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <Btn type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : "Hesap oluştur"}
        </Btn>
      </form>
      <div style={{ marginTop: 14, fontSize: 13, color: "var(--c-tx3)", textAlign: "center" }}>
        Zaten hesabın var mı? <Link href="/login" style={{ color: "var(--c-a)" }}>Giriş yap</Link>
      </div>
    </Card>
  );
}
