"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { copyText } from "../lib/clipboard";
import { buildRecoveryCodesFile, buildRecoveryCodesPrintHtml, downloadTextFile, printHtml } from "../lib/recovery-codes-file";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { Checkbox } from "./form";
import { Modal } from "./modal";
import { useToast } from "./toast";

/**
 * One-time display of freshly issued recovery codes. They can be copied, downloaded as a .txt or printed; the
 * "I've saved them" box stays disabled until at least one of those happened, and the dialog cannot be dismissed
 * by Esc or a stray click (the codes are never shown again).
 */
export function RecoveryCodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const [ack, setAck] = useState(false);

  const file = () =>
    buildRecoveryCodesFile({
      codes,
      origin: window.location.origin,
      now: new Date(),
      labels: { title: t("settings.recoveryFileTitle"), hub: t("settings.recoveryFileHub"), created: t("settings.recoveryFileCreated"), hint: t("settings.recoveryFileHint") },
    });

  const copy = async () => {
    const ok = await copyText(codes.join("\n"));
    toast(ok ? t("common.copied") : t("common.copyFailed"), ok ? "success" : "error");
    if (ok) setSaved(true);
  };
  const download = () => {
    const f = file();
    downloadTextFile(f.filename, f.text);
    setSaved(true);
  };
  const print = () => {
    printHtml(
      buildRecoveryCodesPrintHtml({
        codes,
        origin: window.location.origin,
        now: new Date(),
        labels: { title: t("settings.recoveryFileTitle"), hub: t("settings.recoveryFileHub"), created: t("settings.recoveryFileCreated"), hint: t("settings.recoveryFileHint") },
      }),
    );
    setSaved(true);
  };

  return (
    <Modal onClose={onClose} zIndex={70} ariaLabel={t("settings.recoveryCodesTitle")} closeOnEsc={false} closeOnBackdrop={false}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{t("settings.recoveryCodesTitle")}</div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("settings.recoveryCodesDesc")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6, marginBottom: 14 }}>
        {codes.map((c) => (
          <code key={c} className="mono" style={{ fontSize: 13, padding: "5px 8px", background: "var(--c-el)", borderRadius: "var(--r1)", textAlign: "center" }}>{c}</code>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <Btn variant="ghost" onClick={copy}>{t("settings.copy")}</Btn>
        <Btn variant="ghost" onClick={download}>{t("settings.recoveryDownload")}</Btn>
        <Btn variant="ghost" onClick={print}>{t("settings.recoveryPrint")}</Btn>
      </div>
      <Checkbox checked={ack} onChange={setAck} disabled={!saved} label={t("settings.recoveryAck")} />
      {!saved && <div style={{ fontSize: 11, color: "var(--c-tx3)", marginTop: 6 }}>{t("settings.recoveryAckHint")}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
        <Btn onClick={onClose} disabled={!ack}>{t("settings.recoveryDone")}</Btn>
      </div>
    </Modal>
  );
}

/** After enabling 2FA: offer to end every session except this device (the current one stays signed in). */
export function SignOutOthersDialog({ onDone }: { onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try {
      await api.revokeOtherSessions();
      toast(t("settings.signOutOthersDone"), "success");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : t("settings.signOutOthersFailed"), "error");
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onDone} zIndex={70} ariaLabel={t("settings.signOutOthersTitle")} closeOnBackdrop={false}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{t("settings.signOutOthersTitle")}</div>
      <div style={{ fontSize: 13, color: "var(--c-tx2)", marginBottom: 14 }}>{t("settings.signOutOthersBody")}</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={onDone} disabled={busy}>{t("settings.signOutOthersKeep")}</Btn>
        <Btn onClick={signOut} disabled={busy}>{busy ? "…" : t("settings.signOutOthersCta")}</Btn>
      </div>
    </Modal>
  );
}

const codeInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "8px 12px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  letterSpacing: "0.2em",
  textAlign: "center",
};

/**
 * The whole enrolment flow: QR + 6-digit code → one-time recovery codes → (optionally) "sign out other
 * sessions". Used by Settings, the first-run wizard and the forced-setup page. The session reload (which flips
 * the user's twoFaEnabled) happens only at the very end, so pages that redirect on that flag never tear this
 * flow down while the one-time codes are still on screen.
 */
export function TwoFactorEnroll({
  onEnrolled,
  onCancel,
  offerSignOutOthers = true,
}: {
  onEnrolled: () => void;
  onCancel?: () => void;
  offerSignOutOthers?: boolean;
}) {
  const t = useT();
  const { reload } = useAuth();
  const [setup, setSetup] = useState<{ otpauthUrl: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [phase, setPhase] = useState<"scan" | "codes" | "others">("scan");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // each setup call mints a new secret: never start two (StrictMode remount)
    started.current = true;
    api.setup2fa().then(setSetup).catch((e) => setErr(e instanceof Error ? e.message : t("settings.codeWrong")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = async () => {
    await reload();
    onEnrolled();
  };

  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await api.enable2fa(code.trim());
      setCodes(res.recoveryCodes);
      setPhase("codes");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("settings.codeWrong"));
    }
    setBusy(false);
  };

  return (
    <div>
      {setup ? (
        <form onSubmit={enable}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qrDataUrl} alt={t("settings.qrAlt")} width={160} height={160} style={{ borderRadius: 8, background: "#fff", padding: 8, maxWidth: "100%", height: "auto" }} />
          <div style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0" }}>{t("settings.scanHint")}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              aria-label={t("settings.codePrompt")}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              style={codeInput}
            />
            <Btn type="submit" disabled={busy || code.trim().length !== 6}>{busy ? "…" : t("settings.enable")}</Btn>
            {onCancel && <Btn variant="ghost" onClick={onCancel}>{t("common.cancel")}</Btn>}
          </div>
        </form>
      ) : (
        !err && <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>…</div>
      )}
      {err && <div role="alert" style={{ marginTop: 12, fontSize: 13, color: "var(--c-r)" }}>{err}</div>}

      {phase === "codes" && codes && (
        <RecoveryCodesDialog
          codes={codes}
          onClose={() => {
            if (offerSignOutOthers) setPhase("others");
            else void finish();
          }}
        />
      )}
      {phase === "others" && <SignOutOthersDialog onDone={() => void finish()} />}
    </div>
  );
}
