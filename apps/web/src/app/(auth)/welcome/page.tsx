"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { copyText } from "../../../lib/clipboard";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";
import { Checkbox, Field, Select, TextInput } from "../../../components/form";
import { TwoFactorEnroll } from "../../../components/two-factor";
import type { MailProvider } from "../../../lib/types";
import { CenteredSpinner } from "../../../components/shell";
import { installPhase } from "../../../lib/server-install";
import { InstallTransportNote } from "../../../components/install-transport-note";
import { resolveStep, isSkippable, nextStep, prevStep, stepNumber, TOTAL_STEPS, type Step } from "../../../lib/onboarding-wizard";

type Tr = ReturnType<typeof useT>;
const errStyle: React.CSSProperties = { color: "var(--c-r)", fontSize: 13, marginTop: 8 };
const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "var(--c-tx3)", fontSize: 13, cursor: "pointer", padding: "8px 12px", minHeight: 36 };

/** Public entry: the Suspense boundary is required because the wizard reads useSearchParams(). */
export default function WelcomePage() {
  return (
    <Suspense fallback={<CenteredSpinner />}>
      <Wizard />
    </Suspense>
  );
}

function Wizard() {
  const t = useT();
  const router = useRouter();
  const sp = useSearchParams();
  const { user, loading, initialized } = useAuth();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loggedIn = !!user;
  const step = resolveStep(sp.get("step"), { loggedIn });
  const serverId = sp.get("server");

  // Redirects for the three "not in the wizard" states. loggedIn ⟹ initialized===true (the AuthProvider
  // sets initialized on a successful me()), so these are mutually exclusive with an active wizard and can't
  // ping-pong against the (app)-layout / login-page gates.
  useEffect(() => {
    if (loading || initialized === null) return;
    if (initialized === true && !user) router.replace("/login"); // returning user, logged out
    else if (user && !user.isInstanceOwner) router.replace("/dashboard"); // non-owner has no onboarding
  }, [loading, initialized, user, router]);

  // Move focus to the step heading on advance (a11y: keyboard + screen reader land on the new step).
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  if (loading || initialized === null) return <CenteredSpinner />;
  if (initialized === true && !user) return <CenteredSpinner />; // redirecting → /login
  if (user && !user.isInstanceOwner) return <CenteredSpinner />; // redirecting → /dashboard

  // Editing from the summary: every Save / Skip / Back returns to the summary instead of walking the flow again.
  const fromSummary = sp.get("from") === "summary";

  /** Navigate to a step, carrying the pinned server id (and the "came from the summary" marker) forward. */
  const go = (next: Step, server?: string) => {
    const q = new URLSearchParams();
    q.set("step", next);
    const srv = server ?? serverId;
    if (srv && (next === "add-first-server" || next === "first-workload")) q.set("server", srv);
    if (fromSummary && next !== "summary" && next !== "done") q.set("from", "summary");
    router.replace(`/welcome?${q.toString()}`);
  };
  /** Where a finished (or skipped) step leads: the summary when editing from it, else the next step. */
  const advance = (server?: string) => go(fromSummary ? "summary" : nextStep(step), server);
  const skipStep = () => advance();
  const back = prevStep(step);
  const finishLater = () => router.replace(user?.uiMode === "home" ? "/home" : "/dashboard");

  const n = stepNumber(step);

  return (
    <Card style={{ padding: 24 }}>
      {(fromSummary || back) && step !== "done" && (
        <div style={{ marginBottom: 10 }}>
          <button type="button" onClick={() => (fromSummary ? go("summary") : back && go(back))} style={{ ...linkBtn, padding: "6px 0" }}>
            {"← "}{t(fromSummary ? "onboarding.backToSummary" : "onboarding.back")}
          </button>
        </div>
      )}
      {n > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div
            role="progressbar"
            aria-valuenow={n}
            aria-valuemin={1}
            aria-valuemax={TOTAL_STEPS}
            aria-label={t("onboarding.progressLabel")}
            style={{ height: 4, background: "var(--c-bd)", borderRadius: 2, overflow: "hidden" }}
          >
            <div style={{ width: `${(n / TOTAL_STEPS) * 100}%`, height: "100%", background: "var(--c-a)" }} />
          </div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 6 }}>{t("onboarding.stepOf", { n, total: TOTAL_STEPS })}</div>
        </div>
      )}

      <h1 ref={headingRef} tabIndex={-1} style={{ fontSize: 18, fontWeight: 700, margin: "0 0 6px", outline: "none" }}>
        {t(`onboarding.${headingKey(step)}`)}
      </h1>

      {step === "welcome" && <WelcomeStep t={t} onStart={() => go("create-admin")} />}
      {step === "create-admin" && <CreateAdminStep t={t} onDone={() => go("choose-mode")} />}
      {step === "choose-mode" && <ChooseModeStep t={t} onDone={() => (fromSummary ? go("summary") : go("instance-basics"))} />}
      {step === "instance-basics" && <InstanceBasicsStep t={t} onNext={() => advance()} onSkip={skipStep} />}
      {step === "email" && <EmailStep t={t} onNext={() => advance()} onSkip={skipStep} />}
      {step === "security" && <SecurityStep t={t} onNext={() => advance()} onSkip={skipStep} />}
      {step === "add-first-server" && (
        <AddServerStep t={t} serverId={serverId} onServer={(id) => go("add-first-server", id)} onNext={(srv) => advance(srv)} onSkip={skipStep} />
      )}
      {step === "first-workload" && (
        <FirstWorkloadStep
          t={t}
          isHome={user?.uiMode === "home"}
          onGit={() => router.push(`/resources/new?kind=git${serverId ? `&server=${serverId}` : ""}`)}
          // Home mode's only allowed app route is /app-store (see HOME_ROUTES); /resources/new would bounce.
          onAppStore={() =>
            user?.uiMode === "home"
              ? router.push("/app-store")
              : router.push(`/resources/new?kind=app${serverId ? `&server=${serverId}` : ""}`)
          }
          onSkip={skipStep}
        />
      )}
      {step === "summary" && <SummaryStep t={t} onEdit={(target) => router.replace(`/welcome?step=${target}&from=summary`)} onFinish={() => go("done")} />}
      {/* A Home-mode owner (turnkey single-box) finishes on the launcher, not the fleet dashboard. */}
      {step === "done" && <DoneStep t={t} toHome={user?.uiMode === "home"} onFinish={finishLater} />}

      {isSkippable(step) && (
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <button type="button" onClick={finishLater} style={linkBtn}>{t("onboarding.finishLater")}</button>
        </div>
      )}
    </Card>
  );
}

function headingKey(step: Step): string {
  return {
    welcome: "welcomeHeading",
    "create-admin": "adminHeading",
    "choose-mode": "modeHeading",
    "instance-basics": "basicsHeading",
    email: "emailHeading",
    security: "securityHeading",
    "add-first-server": "serverHeading",
    "first-workload": "workloadHeading",
    summary: "summaryHeading",
    done: "doneHeading",
  }[step];
}

function WelcomeStep({ t, onStart }: { t: Tr; onStart: () => void }) {
  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 18px" }}>{t("onboarding.welcomeBody")}</p>
      <Btn onClick={onStart} style={{ width: "100%" }}>{t("onboarding.welcomeStart")}</Btn>
    </>
  );
}

function CreateAdminStep({ t, onDone }: { t: Tr; onDone: () => void }) {
  const { reload } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // A fresh box installed with SETUP_CODE needs the code to claim the owner account (closes the
  // first-visitor-wins window). The status endpoint exposes only the boolean, never the code.
  const { data: status } = useQuery({ queryKey: ["instance-status"], queryFn: () => api.getInstanceStatus() });
  const needsCode = status?.setupCodeRequired ?? false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.register(email, password, name || undefined, setupCode || undefined);
      await reload(); // becomes the logged-in owner; initialized flips true
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("onboarding.createFailed"));
      setBusy(false);
    }
  };

  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.adminBody")}</p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {needsCode && (
          <Field label={t("onboarding.setupCode")} htmlFor="ob-setup-code" hint={t("onboarding.setupCodeHint")}>
            <TextInput id="ob-setup-code" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} required autoFocus />
          </Field>
        )}
        <Field label={t("onboarding.name")} htmlFor="ob-name">
          <TextInput id="ob-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("onboarding.email")} htmlFor="ob-email">
          <TextInput id="ob-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label={t("onboarding.password")} htmlFor="ob-password">
          <TextInput id="ob-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </Field>
        {err && <div style={errStyle}>{err}</div>}
        <Btn type="submit" disabled={busy} style={{ width: "100%" }}>{busy ? "…" : t("onboarding.createOwner")}</Btn>
      </form>
    </>
  );
}

/** Pick the UI persona: Fleet (full control plane) vs Home (simple launcher). Persists to the owner's
 *  profile so the rest of onboarding and the app land in the right surface. Defaults to whatever the
 *  installer preset (DEFAULT_UI_MODE); the owner can still change it later in Settings. */
function ChooseModeStep({ t, onDone }: { t: Tr; onDone: () => void }) {
  const { user, reload } = useAuth();
  const [busy, setBusy] = useState<"fleet" | "home" | null>(null);
  const [err, setErr] = useState("");
  const current = user?.uiMode === "home" ? "home" : "fleet";

  const pick = async (mode: "fleet" | "home") => {
    setErr("");
    setBusy(mode);
    try {
      if (mode !== current) {
        await api.updateProfile({ uiMode: mode });
        await reload(); // downstream steps + final routing read user.uiMode
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("onboarding.createFailed"));
      setBusy(null);
    }
  };

  const opts: { mode: "fleet" | "home"; label: string; desc: string }[] = [
    { mode: "fleet", label: t("onboarding.modeFleet"), desc: t("onboarding.modeFleetDesc") },
    { mode: "home", label: t("onboarding.modeHome"), desc: t("onboarding.modeHomeDesc") },
  ];

  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.modeBody")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {opts.map((o) => {
          const active = current === o.mode;
          return (
            <button
              key={o.mode}
              type="button"
              onClick={() => pick(o.mode)}
              disabled={busy !== null}
              aria-pressed={active}
              style={{
                textAlign: "left", cursor: busy ? "default" : "pointer", padding: 14,
                background: active ? "var(--c-ad)" : "var(--c-el)",
                border: `1px solid ${active ? "var(--c-a)" : "var(--c-bd)"}`,
                borderRadius: "var(--r1)", color: "var(--c-tx)", fontFamily: "inherit",
              }}
            >
              <span style={{ display: "block", fontWeight: 700, fontSize: 14 }}>{o.label}{busy === o.mode ? " …" : ""}</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", marginTop: 3 }}>{o.desc}</span>
            </button>
          );
        })}
      </div>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 12, textAlign: "center" }}>{t("onboarding.modeSwitchHint")}</div>
    </>
  );
}

/** The owner's own team (the one registration created). Onboarding names it; the default is just "My Team". */
function ownerTeam<T extends { role?: string }>(teams: T[]): T | undefined {
  return teams.find((tm) => tm.role === "OWNER") ?? teams[0];
}
const DEFAULT_TEAM_NAME = "My Team";

function InstanceBasicsStep({ t, onNext, onSkip }: { t: Tr; onNext: () => void; onSkip: () => void }) {
  const { data } = useQuery({ queryKey: ["instance-settings"], queryFn: () => api.getInstanceSettings(), refetchOnWindowFocus: false });
  const { data: teams } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams(), refetchOnWindowFocus: false });
  const team = ownerTeam(teams ?? []);
  const [teamName, setTeamName] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [acmeEmail, setAcmeEmail] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Prefill once settings load (resume-friendly): what the owner saved wins; otherwise what the installer already
  // knew (HUB_PUBLIC_URL / PANEL_DOMAIN / ACME_EMAIL / the owner's email) so they confirm instead of retyping.
  useEffect(() => {
    if (data) {
      setPublicUrl(data.publicUrl ?? data.suggested?.publicUrl ?? "");
      setAcmeEmail(data.acmeEmail ?? data.suggested?.acmeEmail ?? "");
    }
  }, [data]);
  // The placeholder name registration gave the team is not a name: leave the field empty for the owner to fill.
  useEffect(() => {
    if (team) setTeamName(team.name === DEFAULT_TEAM_NAME ? "" : team.name);
  }, [team?.id, team?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Never submit before the current settings have loaded: the prefill runs off `data`, so posting the
  // still-empty "" fields early would map to null on the backend and silently WIPE previously-saved
  // values on the resume path. Gate Save on both queries having settled.
  const loaded = data !== undefined && teams !== undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loaded) return;
    setErr("");
    setBusy(true);
    try {
      const name = teamName.trim();
      if (team && name && name !== team.name) await api.renameTeam(team.id, name);
      await api.updateInstanceSettings({ publicUrl, acmeEmail });
      onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("onboarding.createFailed"));
      setBusy(false);
    }
  };

  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.basicsBody")}</p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label={t("onboarding.teamName")} htmlFor="ob-team-name" hint={t("onboarding.teamNameHint")}>
          <TextInput id="ob-team-name" placeholder={t("onboarding.teamNamePlaceholder")} value={teamName} onChange={(e) => setTeamName(e.target.value)} maxLength={80} autoComplete="organization" />
        </Field>
        <Field label={t("onboarding.publicUrl")} htmlFor="ob-url" hint={t("onboarding.publicUrlHint")}>
          <TextInput id="ob-url" placeholder="https://hub.example.com" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} />
        </Field>
        <Field label={t("onboarding.acmeEmail")} htmlFor="ob-acme" hint={t("onboarding.acmeEmailHint")}>
          <TextInput id="ob-acme" type="email" value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)} />
        </Field>
        <More t={t}>{t("onboarding.basicsMore")}</More>
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn type="submit" disabled={busy || !loaded} style={{ flex: "1 1 160px" }}>{busy ? "…" : t("onboarding.saveContinue")}</Btn>
          <Btn variant="ghost" onClick={onSkip}>{t("onboarding.skipStep")}</Btn>
        </div>
      </form>
    </>
  );
}

/** Details behind a quiet "More" disclosure, so each step stays one short sentence per field. */
function More({ t, children }: { t: Tr; children: React.ReactNode }) {
  return (
    <details style={{ fontSize: 12, color: "var(--c-tx3)" }}>
      <summary style={{ cursor: "pointer", padding: "4px 0" }}>{t("onboarding.more")}</summary>
      <p style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{children}</p>
    </details>
  );
}

/** Optional outbound email (Resend or SMTP). Skipping leaves email off; the same form lives in Settings. */
function EmailStep({ t, onNext, onSkip }: { t: Tr; onNext: () => void; onSkip: () => void }) {
  const { data } = useQuery({ queryKey: ["mailSettings"], queryFn: () => api.getMailSettings(), refetchOnWindowFocus: false });
  const [provider, setProvider] = useState<Exclude<MailProvider, "none">>("resend");
  const [resendKey, setResendKey] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [mailUser, setMailUser] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    if (data.provider !== "none") setProvider(data.provider);
    setHost(data.host ?? "");
    setPort(String(data.port ?? 587));
    setSecure(!!data.secure);
    setMailUser(data.user ?? "");
    setFrom(data.from ?? "");
  }, [data]);

  const configured = !!data && data.effective !== "none";
  const portNum = Number(port);
  const smtpOk = host.trim() !== "" && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const resendOk = resendKey !== "" || !!data?.hasResendKey;
  const valid = from.trim() !== "" && (provider === "smtp" ? smtpOk : resendOk);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setErr("");
    setBusy(true);
    try {
      await api.updateMailSettings({
        provider,
        from: from.trim(),
        ...(provider === "smtp" ? { host: host.trim(), port: portNum, secure, user: mailUser.trim(), ...(password ? { password } : {}) } : {}),
        ...(provider === "resend" && resendKey ? { resendKey } : {}),
      });
      onNext();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("onboarding.createFailed"));
      setBusy(false);
    }
  };

  const choices: { value: Exclude<MailProvider, "none">; label: string }[] = [
    { value: "resend", label: t("settings.mail_providerResend") },
    { value: "smtp", label: t("settings.mail_providerSmtp") },
  ];

  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.emailBody")}</p>
      {configured && <p style={{ fontSize: 13, color: "var(--c-g)", margin: "0 0 12px" }}>{t("onboarding.emailAlready")}</p>}
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div role="group" aria-label={t("settings.mail_provider")} style={{ display: "flex", gap: 8 }}>
          {choices.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={provider === c.value}
              onClick={() => setProvider(c.value)}
              style={{
                flex: 1, minHeight: 40, cursor: "pointer", fontFamily: "inherit", fontSize: 14, color: "var(--c-tx)",
                background: provider === c.value ? "var(--c-ad)" : "var(--c-el)",
                border: `1px solid ${provider === c.value ? "var(--c-a)" : "var(--c-bd)"}`,
                borderRadius: "var(--r1)",
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        {provider === "resend" ? (
          <Field label={t("settings.mail_resendKey")} htmlFor="ob-resend-key">
            <TextInput id="ob-resend-key" type="password" value={resendKey} onChange={(e) => setResendKey(e.target.value)} placeholder={data?.hasResendKey ? t("settings.mail_secretSet") : "re_…"} autoComplete="new-password" />
          </Field>
        ) : (
          <>
            <Field label={t("settings.mail_host")} htmlFor="ob-mail-host">
              <TextInput id="ob-mail-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" autoComplete="off" />
            </Field>
            <Field label={t("settings.mail_port")} htmlFor="ob-mail-port">
              <TextInput id="ob-mail-port" inputMode="numeric" value={port} onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                setPort(v);
                // Port 465 is implicit TLS and 587 is STARTTLS: follow the port so the common cases just work.
                if (v === "465") setSecure(true);
                else if (v === "587") setSecure(false);
              }} />
            </Field>
            <Checkbox id="ob-mail-secure" checked={secure} onChange={setSecure} label={t("settings.mail_secure")} />
            <Field label={t("settings.mail_user")} htmlFor="ob-mail-user">
              <TextInput id="ob-mail-user" value={mailUser} onChange={(e) => setMailUser(e.target.value)} autoComplete="off" />
            </Field>
            <Field label={t("settings.mail_password")} htmlFor="ob-mail-pass">
              <TextInput id="ob-mail-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={data?.hasPassword ? t("settings.mail_secretSet") : undefined} autoComplete="new-password" />
            </Field>
          </>
        )}
        <Field label={t("settings.mail_from")} htmlFor="ob-mail-from">
          <TextInput id="ob-mail-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Tugra <no-reply@example.com>" autoComplete="off" />
        </Field>
        <More t={t}>{t("onboarding.emailLater")}</More>
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn type="submit" disabled={busy || !valid} style={{ flex: "1 1 160px" }}>{busy ? "…" : t("onboarding.emailSave")}</Btn>
          <Btn variant="ghost" onClick={configured && !valid ? onNext : onSkip}>{configured && !valid ? t("onboarding.securityContinue") : t("onboarding.skipStep")}</Btn>
        </div>
      </form>
    </>
  );
}

/** Optional 2FA for the owner, plus the instance policy "Require 2FA for owners and admins". */
function SecurityStep({ t, onNext, onSkip }: { t: Tr; onNext: () => void; onSkip: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const enabled = !!user?.twoFaEnabled;
  const [enrolling, setEnrolling] = useState(false);
  const { data } = useQuery({ queryKey: ["instance-settings"], queryFn: () => api.getInstanceSettings(), refetchOnWindowFocus: false });
  const requireM = useMutation({
    mutationFn: (v: boolean) => api.updateInstanceSettings({ require2fa: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instance-settings"] }),
  });

  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.securityBody")}</p>
      {enabled ? (
        <>
          <p style={{ fontSize: 13, color: "var(--c-g)", margin: "0 0 12px" }}>{t("onboarding.securityOn")}</p>
          <Checkbox
            checked={!!data?.require2fa}
            disabled={!data || requireM.isPending}
            onChange={(v) => requireM.mutate(v)}
            label={t("settings.require2fa")}
          />
          <div style={{ marginTop: 16 }}>
            <Btn onClick={onNext} style={{ width: "100%" }}>{t("onboarding.securityContinue")}</Btn>
          </div>
        </>
      ) : enrolling ? (
        <TwoFactorEnroll offerSignOutOthers={false} onCancel={() => setEnrolling(false)} onEnrolled={() => setEnrolling(false)} />
      ) : (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn onClick={() => setEnrolling(true)} style={{ flex: "1 1 160px" }}>{t("onboarding.securitySetup")}</Btn>
          <Btn variant="ghost" onClick={onSkip}>{t("onboarding.skipStep")}</Btn>
        </div>
      )}
    </>
  );
}

/** Everything the owner entered, in one place, with an Edit link per section, before finishing. */
function SummaryStep({ t, onEdit, onFinish }: { t: Tr; onEdit: (step: Step) => void; onFinish: () => void }) {
  const { user } = useAuth();
  const { data: settings } = useQuery({ queryKey: ["instance-settings"], queryFn: () => api.getInstanceSettings() });
  const { data: teams } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: mail } = useQuery({ queryKey: ["mailSettings"], queryFn: () => api.getMailSettings() });
  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });

  const notSet = t("onboarding.summaryNotSet");
  const team = ownerTeam(teams ?? []);
  const server = (servers ?? []).find((sv) => sv.isLocal) ?? (servers ?? [])[0];
  const mailValue =
    mail && mail.effective !== "none"
      ? mail.provider === "none"
        ? t("settings.mail_effectiveEnv")
        : t(`settings.mail_provider${mail.provider === "resend" ? "Resend" : "Smtp"}`)
      : notSet;
  const twoFaValue = user?.twoFaEnabled ? (settings?.require2fa ? t("onboarding.summaryOnRequired") : t("onboarding.summaryOn")) : t("onboarding.summaryOff");
  const serverValue = server
    ? t(server.status === "ONLINE" ? "onboarding.summaryServerOnline" : "onboarding.summaryServerPending", { name: server.name })
    : t("onboarding.summaryNoServer");

  const rows: { key: string; label: string; value: string; step: Step }[] = [
    { key: "mode", label: t("onboarding.summaryMode"), value: t(user?.uiMode === "home" ? "onboarding.summaryModeHome" : "onboarding.summaryModeFleet"), step: "choose-mode" },
    { key: "team", label: t("onboarding.summaryTeam"), value: team && team.name !== DEFAULT_TEAM_NAME ? team.name : notSet, step: "instance-basics" },
    { key: "url", label: t("onboarding.publicUrl"), value: settings?.publicUrl || notSet, step: "instance-basics" },
    { key: "acme", label: t("onboarding.acmeEmail"), value: settings?.acmeEmail || notSet, step: "instance-basics" },
    { key: "email", label: t("onboarding.summaryEmail"), value: mailValue, step: "email" },
    { key: "2fa", label: t("onboarding.summaryTwoFa"), value: twoFaValue, step: "security" },
    { key: "server", label: t("onboarding.summaryServer"), value: serverValue, step: "add-first-server" },
  ];
  const ready = !!settings && !!teams && !!mail && !!servers;

  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.summaryBody")}</p>
      <dl style={{ margin: "0 0 18px", display: "flex", flexDirection: "column" }}>
        {rows.map((r) => (
          <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid var(--c-bd)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <dt style={{ fontSize: 12, color: "var(--c-tx3)" }}>{r.label}</dt>
              <dd style={{ margin: "2px 0 0", fontSize: 14, wordBreak: "break-word" }}>{r.value}</dd>
            </div>
            <button type="button" onClick={() => onEdit(r.step)} aria-label={t("onboarding.summaryEditAria", { what: r.label })} style={{ ...linkBtn, color: "var(--c-a)" }}>
              {t("onboarding.summaryEdit")}
            </button>
          </div>
        ))}
      </dl>
      <Btn onClick={onFinish} disabled={!ready} style={{ width: "100%" }}>{t("onboarding.summaryFinish")}</Btn>
    </>
  );
}

function AddServerStep({ t, serverId, onServer, onNext, onSkip }: { t: Tr; serverId: string | null; onServer: (id: string) => void; onNext: (srv?: string) => void; onSkip: () => void }) {
  // Turnkey single-box: the local box is already auto-provisioned as "This machine", so
  // skip the manual add form entirely and show it connecting.
  const { data: servers = [], isPending } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  // Wait for the list before deciding — otherwise the manual add form flashes (and could be submitted) on a
  // turnkey box before the local server loads, creating a stray duplicate server.
  if (isPending) return <CenteredSpinner />;
  const pinnedLocal = serverId ? (servers.find((s) => s.id === serverId)?.isLocal ?? false) : false;
  const local = servers.find((s) => s.isLocal);
  // A pinned ?server that IS the local box (e.g. resuming after a refresh) → the local view, not the remote
  // install-command UI. Otherwise an unpinned local box → carry its id forward so first-workload links point at it.
  if (pinnedLocal) return <LocalServerStep t={t} serverId={serverId!} onNext={() => onNext(serverId!)} onSkip={onSkip} />;
  if (!serverId && local) return <LocalServerStep t={t} serverId={local.id} onNext={() => onNext(local.id)} onSkip={onSkip} />;
  if (!serverId) return <CreateServerForm t={t} onServer={onServer} onSkip={onSkip} />;
  return <WaitForServer t={t} serverId={serverId} onNext={() => onNext()} onSkip={onSkip} />;
}

/** Turnkey path: "This machine" is enrolling itself — no install command. Shows live status and lets the
 *  owner continue (the agent finishes connecting in the background). */
function LocalServerStep({ t, serverId, onNext, onSkip }: { t: Tr; serverId: string; onNext: () => void; onSkip: () => void }) {
  const { data } = useQuery({
    queryKey: ["server-install", serverId],
    queryFn: () => api.getServerInstall(serverId),
    refetchInterval: 4000,
    refetchOnWindowFocus: false,
  });
  const online = data?.status === "ONLINE";
  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.localServerBody")}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 18px", fontSize: 14 }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: online ? "var(--c-g)" : "var(--c-am)" }} />
        {online ? t("onboarding.localServerConnected") : t("onboarding.localServerConnecting")}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Btn onClick={onNext} style={{ flex: 1 }}>{t("onboarding.localServerContinue")}</Btn>
        <Btn variant="ghost" onClick={onSkip}>{t("onboarding.skipStep")}</Btn>
      </div>
    </>
  );
}

function CreateServerForm({ t, onServer, onSkip }: { t: Tr; onServer: (id: string) => void; onSkip: () => void }) {
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Create ONLY on explicit submit, then pin ?server=<id> so a refresh resumes instead of creating a duplicate.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await api.createServer(name, teamId);
      onServer(res.server.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("onboarding.createFailed"));
      setBusy(false);
    }
  };

  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.serverBody")}</p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label={t("onboarding.serverNameOptional")} hint={t("onboarding.serverNameHint")}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("onboarding.team")} htmlFor="ob-team">
          <Select id="ob-team" value={teamId} onChange={setTeamId} autoSelectFirst required options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
        </Field>
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn type="submit" disabled={busy || !teamId} style={{ flex: 1 }}>{busy ? "…" : t("onboarding.createServer")}</Btn>
          <Btn variant="ghost" onClick={onSkip}>{t("onboarding.skipStep")}</Btn>
        </div>
      </form>
    </>
  );
}

function WaitForServer({ t, serverId, onNext, onSkip }: { t: Tr; serverId: string; onNext: () => void; onSkip: () => void }) {
  const { data } = useQuery({
    queryKey: ["server-install", serverId],
    queryFn: () => api.getServerInstall(serverId),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  });
  const [waited, setWaited] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => setWaited((w) => w + 5000), 5000);
    return () => clearInterval(iv);
  }, []);

  const online = data?.status === "ONLINE";
  const command = data?.installCommand ?? null;
  const phase = installPhase(command, waited);

  const copy = async () => {
    if (!command) return;
    // copyText falls back to execCommand on an insecure http origin (this command shows on a bare-IP
    // page), so Copy actually works there instead of silently failing; stay quiet if it couldn't.
    if (await copyText(command)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // useMutation: a failure is toasted by the global MutationCache and `isPending` is always released.
  const reissueM = useMutation({
    mutationFn: () => api.reissueServerEnroll(serverId),
    onSuccess: () => setWaited(0),
  });
  const reissuing = reissueM.isPending;
  const reissue = () => reissueM.mutate();

  if (online) {
    return (
      <>
        <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.serverConnected")}</p>
        <Btn onClick={onNext} style={{ width: "100%" }}>{t("onboarding.saveContinue")}</Btn>
      </>
    );
  }

  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 12px" }}>{t("onboarding.runThisCommand")}</p>
      {phase === "expired" ? (
        <>
          <div style={{ fontSize: 13, color: "var(--c-tx2)", marginBottom: 10 }}>{t("onboarding.reissueHint")}</div>
          <Btn onClick={reissue} disabled={reissuing} style={{ width: "100%" }}>{reissuing ? "…" : t("onboarding.reissueCta")}</Btn>
        </>
      ) : (
        <>
          <code style={{ display: "block", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, fontSize: 12, wordBreak: "break-all", marginBottom: 10 }}>
            {command}
          </code>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
            <Btn variant="ghost" onClick={copy}>{copied ? t("onboarding.copied") : t("onboarding.copy")}</Btn>
            <span style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("onboarding.waitingForServer")}</span>
          </div>
          <div style={{ marginBottom: 12 }}><InstallTransportNote command={command} /></div>
        </>
      )}
      <div style={{ textAlign: "center" }}>
        <button type="button" onClick={onSkip} style={linkBtn}>{t("onboarding.skipStep")}</button>
      </div>
    </>
  );
}

function FirstWorkloadStep({ t, isHome, onGit, onAppStore, onSkip }: { t: Tr; isHome?: boolean; onGit: () => void; onAppStore: () => void; onSkip: () => void }) {
  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.workloadBody")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Home mode is app-store first; Git deploy is a fleet concept (and its route would bounce in Home). */}
        {!isHome && <Btn onClick={onGit} style={{ width: "100%" }}>{t("onboarding.deployGit")}</Btn>}
        <Btn variant={isHome ? "primary" : "ghost"} onClick={onAppStore} style={{ width: "100%" }}>{t("onboarding.browseAppStore")}</Btn>
      </div>
      <div style={{ marginTop: 12, textAlign: "center" }}>
        <button type="button" onClick={onSkip} style={linkBtn}>{t("onboarding.skipStep")}</button>
      </div>
    </>
  );
}

function DoneStep({ t, onFinish, toHome }: { t: Tr; onFinish: () => void; toHome?: boolean }) {
  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 18px" }}>{t("onboarding.doneBody")}</p>
      <Btn onClick={onFinish} style={{ width: "100%" }}>{t(toHome ? "onboarding.goToLauncher" : "onboarding.goToDashboard")}</Btn>
    </>
  );
}
