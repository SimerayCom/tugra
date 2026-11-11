"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { MailMinus } from "lucide-react";
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
 */
export function MailNotConfiguredNote({ consequence }: { consequence?: string }) {
  const t = useT();
  const { user } = useAuth();
  const { data } = useQuery({ queryKey: ["instanceStatus"], queryFn: () => api.getInstanceStatus(), staleTime: 60_000 });
  if (data?.mailConfigured !== false) return null;
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
      <div style={{ fontSize: 12.5, color: "var(--c-tx2)" }}>
        <strong style={{ color: "var(--c-tx)" }}>{t("common.mailNotConfigured")}</strong>
        {consequence ? ` ${consequence}` : ""}{" "}
        {isOwner ? (
          <Link href="/settings?tab=instance#email" className="tg-link">
            {t("common.mailNotConfiguredSetup")}
          </Link>
        ) : (
          t("common.mailNotConfiguredAskAdmin")
        )}
      </div>
    </div>
  );
}
