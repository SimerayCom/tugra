"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Btn, Card } from "../../../components/ui";
import { Field, Select, TextInput } from "../../../components/form";
import { CenteredSpinner } from "../../../components/shell";
import { installPhase } from "../../../lib/server-install";
import { resolveStep, isSkippable, stepNumber, TOTAL_STEPS, type Step } from "../../../lib/onboarding-wizard";

type Tr = ReturnType<typeof useT>;
const errStyle: React.CSSProperties = { color: "var(--c-r)", fontSize: 13, marginTop: 8 };
const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "var(--c-tx3)", fontSize: 13, cursor: "pointer" };

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

  /** Navigate to a step, carrying the pinned server id forward where the step needs it. */
  const go = (next: Step, server?: string) => {
    const q = new URLSearchParams();
    q.set("step", next);
    const srv = server ?? serverId;
    if (srv && (next === "add-first-server" || next === "first-workload")) q.set("server", srv);
    router.replace(`/welcome?${q.toString()}`);
  };

  const n = stepNumber(step);

  return (
    <Card style={{ padding: 24 }}>
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
      {step === "create-admin" && <CreateAdminStep t={t} onDone={() => go("instance-basics")} />}
      {step === "instance-basics" && <InstanceBasicsStep t={t} onNext={() => go("add-first-server")} onSkip={() => go("done")} />}
      {step === "add-first-server" && (
        <AddServerStep t={t} serverId={serverId} onServer={(id) => go("add-first-server", id)} onNext={() => go("first-workload")} onSkip={() => go("done")} />
      )}
      {step === "first-workload" && (
        <FirstWorkloadStep
          t={t}
          onGit={() => router.push(`/resources/new?kind=git${serverId ? `&server=${serverId}` : ""}`)}
          onAppStore={() => router.push(`/resources/new?kind=app${serverId ? `&server=${serverId}` : ""}`)}
          onSkip={() => go("done")}
        />
      )}
      {step === "done" && <DoneStep t={t} onFinish={() => router.replace("/dashboard")} />}

      {isSkippable(step) && (
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <button type="button" onClick={() => router.replace("/dashboard")} style={linkBtn}>{t("onboarding.skipAll")}</button>
        </div>
      )}
    </Card>
  );
}

function headingKey(step: Step): string {
  return {
    welcome: "welcomeHeading",
    "create-admin": "adminHeading",
    "instance-basics": "basicsHeading",
    "add-first-server": "serverHeading",
    "first-workload": "workloadHeading",
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

function InstanceBasicsStep({ t, onNext, onSkip }: { t: Tr; onNext: () => void; onSkip: () => void }) {
  const { data } = useQuery({ queryKey: ["instance-settings"], queryFn: () => api.getInstanceSettings(), refetchOnWindowFocus: false });
  const [publicUrl, setPublicUrl] = useState("");
  const [acmeEmail, setAcmeEmail] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Prefill once settings load (resume-friendly).
  useEffect(() => {
    if (data) {
      setPublicUrl(data.publicUrl ?? "");
      setAcmeEmail(data.acmeEmail ?? "");
    }
  }, [data]);

  // Never submit before the current settings have loaded: the prefill runs off `data`, so posting the
  // still-empty "" fields early would map to null on the backend and silently WIPE previously-saved
  // values on the resume path. Gate Save on the query having settled with data.
  const loaded = data !== undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loaded) return;
    setErr("");
    setBusy(true);
    try {
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
        <Field label={t("onboarding.publicUrl")} htmlFor="ob-url" hint={t("onboarding.publicUrlHint")}>
          <TextInput id="ob-url" placeholder="https://hub.example.com" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} />
        </Field>
        <Field label={t("onboarding.acmeEmail")} htmlFor="ob-acme" hint={t("onboarding.acmeEmailHint")}>
          <TextInput id="ob-acme" type="email" value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)} />
        </Field>
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn type="submit" disabled={busy || !loaded} style={{ flex: 1 }}>{busy ? "…" : t("onboarding.saveContinue")}</Btn>
          <Btn variant="ghost" onClick={onSkip}>{t("onboarding.skip")}</Btn>
        </div>
      </form>
    </>
  );
}

function AddServerStep({ t, serverId, onServer, onNext, onSkip }: { t: Tr; serverId: string | null; onServer: (id: string) => void; onNext: () => void; onSkip: () => void }) {
  if (!serverId) return <CreateServerForm t={t} onServer={onServer} onSkip={onSkip} />;
  return <WaitForServer t={t} serverId={serverId} onNext={onNext} onSkip={onSkip} />;
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
        <Field label={t("onboarding.serverName")} htmlFor="ob-srv">
          <TextInput id="ob-srv" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label={t("onboarding.team")} htmlFor="ob-team">
          <Select id="ob-team" value={teamId} onChange={setTeamId} autoSelectFirst required options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
        </Field>
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn type="submit" disabled={busy || !teamId} style={{ flex: 1 }}>{busy ? "…" : t("onboarding.createServer")}</Btn>
          <Btn variant="ghost" onClick={onSkip}>{t("onboarding.skip")}</Btn>
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
  const [reissuing, setReissuing] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => setWaited((w) => w + 5000), 5000);
    return () => clearInterval(iv);
  }, []);

  const online = data?.status === "ONLINE";
  const command = data?.installCommand ?? null;
  const phase = installPhase(command, waited);

  const copy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the command is still visible to copy manually */
    }
  };

  const reissue = async () => {
    setReissuing(true);
    try {
      await api.reissueServerEnroll(serverId);
    } finally {
      setReissuing(false);
      setWaited(0);
    }
  };

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
        </>
      )}
      <div style={{ textAlign: "center" }}>
        <button type="button" onClick={onSkip} style={linkBtn}>{t("onboarding.skip")}</button>
      </div>
    </>
  );
}

function FirstWorkloadStep({ t, onGit, onAppStore, onSkip }: { t: Tr; onGit: () => void; onAppStore: () => void; onSkip: () => void }) {
  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t("onboarding.workloadBody")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Btn onClick={onGit} style={{ width: "100%" }}>{t("onboarding.deployGit")}</Btn>
        <Btn variant="ghost" onClick={onAppStore} style={{ width: "100%" }}>{t("onboarding.browseAppStore")}</Btn>
      </div>
      <div style={{ marginTop: 12, textAlign: "center" }}>
        <button type="button" onClick={onSkip} style={linkBtn}>{t("onboarding.skip")}</button>
      </div>
    </>
  );
}

function DoneStep({ t, onFinish }: { t: Tr; onFinish: () => void }) {
  return (
    <>
      <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 18px" }}>{t("onboarding.doneBody")}</p>
      <Btn onClick={onFinish} style={{ width: "100%" }}>{t("onboarding.goToDashboard")}</Btn>
    </>
  );
}
