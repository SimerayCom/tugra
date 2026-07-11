"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { useAuth } from "../../../../lib/auth";
import { useT } from "../../../../i18n/provider";
import { Btn, Card } from "../../../../components/ui";

export default function InvitePage() {
  const token = String(useParams().token ?? "");
  const t = useT();
  const router = useRouter();
  const { user, reload } = useAuth();

  const { data: preview, isLoading, isError } = useQuery({
    queryKey: ["invitePreview", token],
    queryFn: () => api.previewInvitation(token),
    retry: false, // a 404 is a final answer, not a transient error
    enabled: !!token,
  });

  const respond = useMutation({
    mutationFn: (accept: boolean) => (accept ? api.acceptInvitation(token) : api.declineInvitation(token)),
    onSuccess: () => router.replace("/teams"),
  });

  const switchAccount = async () => {
    await api.logout();
    await reload(); // drops to the logged-out CTAs on this same page
  };

  if (isLoading) {
    return (
      <Card style={{ padding: 24 }}>
        <div style={{ fontSize: 14, color: "var(--c-tx3)" }}>{t("teams.inviteLoading")}</div>
      </Card>
    );
  }
  if (isError || !preview) {
    return (
      <Card style={{ padding: 24 }}>
        <div style={{ fontSize: 14, color: "var(--c-tx2)", marginBottom: 12 }}>{t("teams.inviteNotFound")}</div>
        <Link href="/login" style={{ color: "var(--c-a)", fontSize: 13 }}>{t("auth.backToLogin")}</Link>
      </Card>
    );
  }

  const emailMatches = !!user && user.email.toLowerCase() === preview.email.toLowerCase();

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 12px" }}>{t("teams.inviteTitle")}</h1>
      <p style={{ fontSize: 14, color: "var(--c-tx)", lineHeight: 1.5, margin: "0 0 4px" }}>
        {t("teams.invitePreview", { team: preview.teamName, role: preview.role })}
      </p>
      {preview.inviterName && (
        <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 4px" }}>{t("teams.inviteBy", { name: preview.inviterName })}</p>
      )}
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 18px" }}>{t("teams.inviteFor", { email: preview.email })}</p>

      {preview.expired ? (
        <div style={{ fontSize: 13, color: "var(--c-am)" }}>{t("teams.inviteExpired")}</div>
      ) : emailMatches ? (
        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={() => respond.mutate(true)} disabled={respond.isPending} style={{ flex: 1 }}>
            {respond.isPending ? "…" : t("teams.inviteAcceptCta")}
          </Btn>
          <Btn variant="ghost" onClick={() => respond.mutate(false)} disabled={respond.isPending}>{t("teams.decline")}</Btn>
        </div>
      ) : user ? (
        <div>
          <div style={{ fontSize: 13, color: "var(--c-am)", marginBottom: 12 }}>{t("teams.inviteWrongAccount", { you: user.email })}</div>
          <Btn variant="ghost" onClick={switchAccount}>{t("teams.inviteSwitchAccount")}</Btn>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Link href={`/login?invite=${encodeURIComponent(token)}`}>
            <Btn style={{ width: "100%" }}>{t("teams.inviteSignInCta")}</Btn>
          </Link>
          <Link href={`/register?invite=${encodeURIComponent(token)}`}>
            <Btn variant="ghost" style={{ width: "100%" }}>{t("teams.inviteCreateCta")}</Btn>
          </Link>
        </div>
      )}
    </Card>
  );
}
