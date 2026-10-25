"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Home, Server } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { ApiTokensCard } from "./api-tokens-card";
import { InstanceApiAccessCard } from "./instance-api-access-card";
import { LicenseCard } from "./license-card";
import { SsoConfigCard } from "./sso-config-card";
import { TelemetryCard } from "./telemetry-card";
import { BrandingCard } from "./branding-card";
import { UpdatesCard } from "./updates-card";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";
import { Field, TextInput } from "../../../components/form";
import { CopyBtn } from "../../../components/copy-row";
import { useConfirm } from "../../../components/confirm";
import { useToast } from "../../../components/toast";
import { Modal } from "../../../components/modal";

/** A labelled settings section: an uppercase heading + an optional hint + a responsive card grid. The grid
 *  is 1 column on phones and flows to 2+ columns on wider screens (min(100%,…) keeps a card from overflowing
 *  a narrow viewport); `align-items:start` stops a tall card from stretching its shorter row-mate. */
function SettingsSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--c-tx3)", margin: "0 0 4px" }}>{title}</h2>
      {hint && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 12px", maxWidth: 560 }}>{hint}</p>}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))",
          gap: 16,
          alignItems: "start",
          marginTop: hint ? 0 : 12,
        }}
      >
        {children}
      </div>
    </section>
  );
}

/** A card that should span the whole section width (tables / long forms read badly in a narrow column). */
function Wide({ children }: { children: React.ReactNode }) {
  return <div style={{ gridColumn: "1 / -1" }}>{children}</div>;
}

export default function SettingsPage() {
  const t = useT();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;

  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 1040, margin: "0 auto" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 4px" }}>{t("settings.title")}</h1>

      <SettingsSection title={t("settings.sectionAccount")}>
        <AccountCard />
        <UiModeCard />
      </SettingsSection>

      <SettingsSection title={t("settings.sectionSecurity")}>
        <PasswordCard />
        <TwoFactorCard />
        <SessionsCard />
        <ChannelsCard />
        <Wide><ApiTokensCard /></Wide>
      </SettingsSection>

      {isOwner && (
        <SettingsSection title={t("settings.sectionInstance")} hint={t("settings.sectionInstanceHint")}>
          <LicenseCard />
          <BrandingCard />
          <InstanceApiAccessCard />
          <UpdatesCard />
          <TelemetryCard />
          <Wide><SsoConfigCard /></Wide>
        </SettingsSection>
      )}
    </div>
  );
}

/** Shortcut to the notification-channel manager (not owner-only). */
function ChannelsCard() {
  const t = useT();
  return (
    <Card style={{ padding: 18, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{t("settings.channels")}</div>
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("settings.channelsDesc")}</div>
      </div>
      <Link href="/notifications"><Btn variant="ghost">{t("settings.channelsManage")}</Btn></Link>
    </Card>
  );
}

function AccountCard() {
  const t = useT();
  const { user, reload } = useAuth();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  useEffect(() => {
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
    setPw("");
  }, [user]);
  // An email change is deferred + password-gated on the server; the new address must confirm a link.
  const emailChanged = email.trim() !== (user?.email ?? "");
  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        currentPassword: emailChanged ? pw : undefined,
      }),
    onSuccess: async () => {
      const target = email.trim();
      const wasEmailChange = emailChanged;
      await reload(); // resets `email` back to the (unchanged) current address via the effect
      setPw("");
      toast(wasEmailChange ? t("settings.emailVerifyPending", { email: target }) : t("settings.profileSaved"), "success");
    },
    onError: (e) => toast(e instanceof Error ? e.message : t("settings.profileSaveFailed"), "error"),
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
        {emailChanged && (
          <Field label={t("settings.currentPasswordToChangeEmail")} htmlFor="acc-pw">
            <TextInput id="acc-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          </Field>
        )}
      </div>
      <div style={{ marginTop: 14 }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending || !email.trim() || (emailChanged && !pw)}>
          {save.isPending ? "…" : t("settings.save")}
        </Btn>
      </div>
    </Card>
  );
}

function UiModeCard() {
  const t = useT();
  const { user, reload } = useAuth();
  const toast = useToast();
  const mode = user?.uiMode ?? "fleet";
  const set = useMutation({
    mutationFn: (uiMode: "fleet" | "home") => api.updateProfile({ uiMode }),
    onSuccess: async () => { await reload(); toast(t("settings.uiModeSaved"), "success"); },
  });
  const opts: { value: "fleet" | "home"; label: string; desc: string; icon: typeof Home }[] = [
    { value: "fleet", label: t("settings.uiModeFleet"), desc: t("settings.uiModeFleetDesc"), icon: Server },
    { value: "home", label: t("settings.uiModeHome"), desc: t("settings.uiModeHomeDesc"), icon: Home },
  ];
  return (
    <Card style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ fontWeight: 600 }}>{t("settings.uiMode")}</div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("settings.uiModeDesc")}</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {opts.map((o) => {
          const active = mode === o.value;
          const Icon = o.icon;
          return (
            <button
              key={o.value}
              onClick={() => { if (!active) set.mutate(o.value); }}
              disabled={set.isPending}
              aria-pressed={active}
              style={{
                flex: "1 1 200px", textAlign: "left", cursor: active ? "default" : "pointer",
                display: "flex", gap: 10, alignItems: "flex-start", padding: 12,
                background: active ? "var(--c-ad)" : "var(--c-el)",
                border: `1px solid ${active ? "var(--c-a)" : "var(--c-bd)"}`,
                borderRadius: "var(--r1)", color: "var(--c-tx)", fontFamily: "inherit",
              }}
            >
              <Icon size={18} style={{ flexShrink: 0, marginTop: 1, color: active ? "var(--c-a)" : "var(--c-tx3)" }} />
              <span>
                <span style={{ display: "block", fontWeight: 600, fontSize: 13 }}>{o.label}</span>
                <span style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", marginTop: 2 }}>{o.desc}</span>
              </span>
            </button>
          );
        })}
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

function SessionsCard() {
  const t = useT();
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const logoutEverywhere = async () => {
    if (!(await confirm({ body: t("settings.logoutEverywhereConfirm"), danger: true }))) return;
    setBusy(true);
    await api.logoutAll();
    router.replace("/login");
  };
  return (
    <Card style={{ padding: 18, marginTop: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{t("settings.sessions")}</div>
        <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("settings.sessionsDesc")}</div>
      </div>
      <Btn variant="ghost" onClick={logoutEverywhere} disabled={busy}>{busy ? "…" : t("settings.logoutEverywhere")}</Btn>
    </Card>
  );
}

const modalField: React.CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 14,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

function TwoFactorCard() {
  const t = useT();
  const { user, reload } = useAuth();
  const qc = useQueryClient();
  const enabled = !!user?.twoFaEnabled;
  const [setup, setSetup] = useState<{ otpauthUrl: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null); // shown once after enable/regenerate
  const [sudo, setSudo] = useState<null | "disable" | "regenerate">(null);
  const { data: status } = useQuery({ queryKey: ["recoveryStatus"], queryFn: () => api.recoveryCodesStatus(), enabled });

  const startSetup = async () => { setErr(""); setSetup(await api.setup2fa()); };
  const enable = async () => {
    setErr("");
    try {
      const { recoveryCodes } = await api.enable2fa(code);
      setSetup(null);
      setCode("");
      await reload();
      qc.invalidateQueries({ queryKey: ["recoveryStatus"] });
      setFreshCodes(recoveryCodes); // surface the one-time codes
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("settings.codeWrong"));
    }
  };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t("settings.twoFa")}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{enabled ? t("settings.enabled") : t("settings.disabled")}</div>
        </div>
        {!enabled && !setup && <Btn onClick={startSetup}>{t("settings.setup")}</Btn>}
        {enabled && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={() => setSudo("regenerate")}>{t("settings.regenerate")}</Btn>
            <Btn variant="danger" onClick={() => setSudo("disable")}>{t("settings.disable2fa")}</Btn>
          </div>
        )}
      </div>

      {enabled && status && (
        <div style={{ fontSize: 12, color: status.remaining <= 2 ? "var(--c-r)" : "var(--c-tx3)", marginTop: 8 }}>
          {t("settings.recoveryRemaining", { n: status.remaining })}
        </div>
      )}

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
      {err && <div style={{ marginTop: 12, fontSize: 13, color: "var(--c-r)" }}>{err}</div>}

      {freshCodes && <RecoveryCodesModal codes={freshCodes} onClose={() => setFreshCodes(null)} />}
      {sudo && (
        <SudoPrompt
          kind={sudo}
          onClose={() => setSudo(null)}
          onDone={async (codes) => {
            setSudo(null);
            await reload();
            qc.invalidateQueries({ queryKey: ["recoveryStatus"] });
            if (codes) setFreshCodes(codes);
          }}
        />
      )}
    </Card>
  );
}

/** Password + 2FA-code sudo prompt for disabling 2FA or regenerating recovery codes. */
function SudoPrompt({ kind, onClose, onDone }: { kind: "disable" | "regenerate"; onClose: () => void; onDone: (codes: string[] | null) => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr("");
    setBusy(true);
    try {
      if (kind === "disable") {
        await api.disable2fa(password, code);
        onDone(null);
      } else {
        const { recoveryCodes } = await api.regenerateRecoveryCodes(password, code);
        onDone(recoveryCodes);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("settings.codeWrong"));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} zIndex={70}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{kind === "disable" ? t("settings.disable2fa") : t("settings.regenerate")}</div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("settings.sudoDesc")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input type="password" placeholder={t("settings.currentPassword")} value={password} onChange={(e) => setPassword(e.target.value)} style={modalField} autoFocus />
        <input className="mono" placeholder={t("settings.codePrompt")} value={code} onChange={(e) => setCode(e.target.value)} style={modalField} />
      </div>
      {err && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn variant={kind === "disable" ? "danger" : "primary"} onClick={submit} disabled={busy || !password || !code}>{busy ? "…" : t("common.confirm")}</Btn>
      </div>
    </Modal>
  );
}

/** One-time display of freshly issued recovery codes. */
function RecoveryCodesModal({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const t = useT();
  return (
    <Modal onClose={onClose} zIndex={70}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{t("settings.recoveryCodesTitle")}</div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("settings.recoveryCodesDesc")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 14 }}>
        {codes.map((c) => (
          <code key={c} className="mono" style={{ fontSize: 13, padding: "5px 8px", background: "var(--c-el)", borderRadius: "var(--r1)", textAlign: "center" }}>{c}</code>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <CopyBtn text={codes.join("\n")} label={t("settings.copy")} />
        <Btn onClick={onClose}>{t("settings.savedThem")}</Btn>
      </div>
    </Modal>
  );
}
