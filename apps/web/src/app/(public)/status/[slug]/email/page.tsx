"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../../../../lib/api";
import { useT } from "../../../../../i18n/provider";
import { Btn, Card } from "../../../../../components/ui";

/** Landing page of the emailed confirm / unsubscribe links. The action is a POST behind a button (never a GET), so a
 *  mail scanner that opens the link can't confirm or cancel anyone's subscription. */
function EmailAction() {
  const t = useT();
  const slug = String(useParams().slug ?? "");
  const q = useSearchParams();
  const token = q.get("token") ?? "";
  const action = q.get("action") === "unsubscribe" ? "unsubscribe" : "confirm";
  const run = useMutation({ mutationFn: () => (action === "confirm" ? api.confirmStatusSubscription(token) : api.unsubscribeFromStatus(token)) });

  return (
    <Card style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>{t(action === "confirm" ? "statusPage.email.confirmTitle" : "statusPage.email.unsubTitle")}</h1>
      {run.isSuccess ? (
        <p role="status" style={{ fontSize: 14, color: "var(--c-g)", margin: "0 0 16px" }}>{t(action === "confirm" ? "statusPage.email.confirmed" : "statusPage.email.unsubscribed")}</p>
      ) : run.isError || !token ? (
        <p role="alert" style={{ fontSize: 14, color: "var(--c-r)", margin: "0 0 16px" }}>{t("statusPage.email.invalid")}</p>
      ) : (
        <>
          <p style={{ fontSize: 14, color: "var(--c-tx2)", margin: "0 0 16px" }}>{t(action === "confirm" ? "statusPage.email.confirmBody" : "statusPage.email.unsubBody")}</p>
          <Btn onClick={() => run.mutate()} loading={run.isPending}>{t(action === "confirm" ? "statusPage.email.confirmCta" : "statusPage.email.unsubCta")}</Btn>
        </>
      )}
      <div style={{ marginTop: 16 }}>
        <Link href={`/status/${encodeURIComponent(slug)}`} className="tg-link" style={{ fontSize: 13 }}>{t("statusPage.email.backToStatus")}</Link>
      </div>
    </Card>
  );
}

export default function StatusEmailPage() {
  return (
    <Suspense>
      <EmailAction />
    </Suspense>
  );
}
