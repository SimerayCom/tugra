"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { MailMinus, X } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../i18n/provider";

/**
 * Calm inline notice for a surface that depends on the hub's outbound mailer when that mailer is NOT
 * configured (instanceStatus.mailConfigured === false). It replaces the "looks broken / silently does
 * nothing" feel with an honest, low-key explanation: email is off, here is the consequence (passed in),
 * and — for an owner — a direct link to Settings → Email. Renders nothing when mail is configured or the
 * status hasn't loaded yet, so a surface that doesn't need mail stays untouched. Shares the cached
 * ["instanceStatus"] query, so it adds no request.
 *
 * `dismissible` turns it into a banner the user can close. The choice is remembered in this browser (shared by
 * every dismissible instance, so it is one banner, not one per page) and forgotten again once email is set up.
 */
export const MAIL_NOTE_DISMISS_KEY = "tugra.dismissed.mailNotConfigured";

function readDismissed(): boolean {
  try { return localStorage.getItem(MAIL_NOTE_DISMISS_KEY) === "1"; } catch { return false; }
}

export function MailNotConfiguredNote({ consequence, dismissible }: { consequence?: string; dismissible?: boolean }) {
  const t = useT();
  const { user } = useAuth();
  const { data } = useQuery({ queryKey: ["instanceStatus"], queryFn: () => api.getInstanceStatus(), staleTime: 60_000 });
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(readDismissed()); }, []);
  // Once email works the dismissal has done its job: forget it so a later outage warns again.
  useEffect(() => {
    if (data?.mailConfigured !== true) return;
    try { localStorage.removeItem(MAIL_NOTE_DISMISS_KEY); } catch { /* storage unavailable */ }
    setDismissed(false);
  }, [data?.mailConfigured]);
  if (data?.mailConfigured !== false) return null;
  if (dismissible && dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(MAIL_NOTE_DISMISS_KEY, "1"); } catch { /* storage unavailable */ }
  };
  const isOwner = !!user?.isInstanceOwner;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "10px 12px",
        background: "color-mix(in srgb, var(--c-am) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--c-am) 35%, transparent)",
        borderRadius: "var(--r1)",
        lineHeight: 1.5,
      }}
    >
      <MailMinus size={15} aria-hidden style={{ color: "var(--c-am)", flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 12.5, color: "var(--c-tx2)", flex: 1, minWidth: 0 }}>
        <strong style={{ color: "var(--c-tx)" }}>{t("common.mailNotConfigured")}</strong>
        {consequence ? ` ${consequence}` : ""}{" "}
        {isOwner ? (
          <Link href="/settings?tab=instance&section=email#email" className="tg-link">
            {t("common.mailNotConfiguredSetup")}
          </Link>
        ) : (
          t("common.mailNotConfiguredAskAdmin")
        )}
      </div>
      {dismissible && (
        <button
          type="button" onClick={dismiss} aria-label={t("common.dismiss")}
          style={{ background: "transparent", border: "none", color: "var(--c-tx3)", cursor: "pointer", padding: 2, display: "inline-flex", flexShrink: 0 }}
        >
          <X size={15} aria-hidden />
        </button>
      )}
    </div>
  );
}
