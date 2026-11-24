"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Rss } from "lucide-react";
import { api } from "../../../../lib/api";
import type { PublicStatus } from "../../../../lib/types";
import { dayColor, incidentDuration, monitorTone, overallTone } from "../../../../lib/status-page";
import { useT } from "../../../../i18n/provider";
import { Badge, Btn, Card, Spinner } from "../../../../components/ui";
import { fieldStyle } from "../../../../components/form";

const BANNER: Record<ReturnType<typeof overallTone>, string> = {
  ok: "var(--c-g)",
  warn: "var(--c-am)",
  danger: "var(--c-r)",
  muted: "var(--c-tx3)",
};

export default function PublicStatusPage() {
  const t = useT();
  const slug = String(useParams().slug ?? "");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["publicStatus", slug],
    queryFn: () => api.getPublicStatus(slug),
    retry: false,
    refetchInterval: 60_000,
    enabled: !!slug,
  });

  if (isLoading) return <div style={{ padding: 32, display: "flex", justifyContent: "center" }}><Spinner /></div>;
  if (isError || !data) {
    return (
      <Card style={{ padding: 24 }}>
        <p role="alert" style={{ margin: 0, fontSize: 14, color: "var(--c-tx2)" }}>{t("statusPage.notFound")}</p>
      </Card>
    );
  }
  return <StatusView slug={slug} data={data} />;
}

function StatusView({ slug, data }: { slug: string; data: PublicStatus }) {
  const t = useT();
  const tone = overallTone(data.overall);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>{data.title}</h1>
        {data.description && <p style={{ margin: "6px 0 0", fontSize: 14, color: "var(--c-tx2)" }}>{data.description}</p>}
      </header>

      <div
        role="status"
        data-testid="status-banner"
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderRadius: "var(--r2, 10px)", border: `1px solid ${BANNER[tone]}`, background: `color-mix(in srgb, ${BANNER[tone]} 12%, transparent)`, fontWeight: 600, fontSize: 15 }}
      >
        <span aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", background: BANNER[tone], flexShrink: 0 }} />
        {t(`statusPage.overall.${data.overall}`)}
      </div>

      {data.monitors.length > 0 && (
        <Card style={{ padding: 0 }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {data.monitors.map((m, i) => (
              <li key={`${m.name}-${i}`} style={{ padding: "14px 16px", borderTop: i ? "1px solid var(--c-bd)" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ flex: 1, minWidth: 120, fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>{m.name}</span>
                  <Badge tone={monitorTone(m.status)}>{t(`statusPage.state.${m.status}`)}</Badge>
                </div>
                <div role="img" aria-label={t("statusPage.daysGroup")} style={{ display: "flex", gap: 2, marginTop: 10, height: 26 }}>
                  {m.days.map((d) => (
                    <span
                      key={d.date}
                      title={d.uptime === null ? t("statusPage.dayNoData", { date: d.date }) : t("statusPage.dayUptime", { date: d.date, pct: d.uptime })}
                      style={{ flex: 1, minWidth: 2, borderRadius: 2, background: dayColor(d.uptime) }}
                    />
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 6 }}>
                  {m.uptime === null ? t("statusPage.noUptime") : t("statusPage.uptime30", { pct: m.uptime })}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <section aria-labelledby="st-maint">
        <h2 id="st-maint" style={{ fontSize: 15, fontWeight: 700, margin: "0 0 8px" }}>{t("statusPage.maintenance")}</h2>
        {data.maintenance.filter((m) => m.state !== "completed").length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t("statusPage.noMaintenance")}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.maintenance.filter((m) => m.state !== "completed").map((m) => (
              <Card key={m.id} style={{ padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 14 }}>{m.title}</strong>
                  <Badge tone={m.state === "active" ? "warn" : "muted"}>{t(m.state === "active" ? "statusPage.maintActive" : "statusPage.maintScheduled")}</Badge>
                </div>
                <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 4 }}>
                  <time dateTime={m.startsAt}>{new Date(m.startsAt).toLocaleString()}</time> – <time dateTime={m.endsAt}>{new Date(m.endsAt).toLocaleString()}</time>
                </div>
                {m.body && <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--c-tx2)", whiteSpace: "pre-wrap" }}>{m.body}</p>}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="st-inc">
        <h2 id="st-inc" style={{ fontSize: 15, fontWeight: 700, margin: "0 0 8px" }}>{t("statusPage.incidents")}</h2>
        {data.incidents.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--c-tx3)" }}>{t("statusPage.noIncidents")}</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {data.incidents.map((i) => (
              <li key={`${i.monitor}-${i.startedAt}`}>
                <Card style={{ padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 14 }}>{t("statusPage.incidentDown", { monitor: i.monitor })}</strong>
                    <Badge tone={i.resolvedAt ? "ok" : "danger"}>{i.resolvedAt ? incidentDuration(i.startedAt, i.resolvedAt, t) : t("statusPage.incidentOngoing")}</Badge>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 4 }}>
                    <time dateTime={i.startedAt}>{new Date(i.startedAt).toLocaleString()}</time>
                    {i.resolvedAt && <> · {t("statusPage.incidentResolved", { duration: incidentDuration(i.startedAt, i.resolvedAt, t) })}</>}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Subscribe slug={slug} emailUpdates={data.emailUpdates} />

      <p style={{ margin: 0, fontSize: 11, color: "var(--c-tx3)" }}>{t("statusPage.updatedAt", { time: new Date(data.updatedAt).toLocaleTimeString() })}</p>
    </div>
  );
}

function Subscribe({ slug, emailUpdates }: { slug: string; emailUpdates: boolean }) {
  const t = useT();
  const [email, setEmail] = useState("");
  const sub = useMutation({ mutationFn: () => api.subscribeToStatus(slug, email) });
  return (
    <section aria-labelledby="st-sub">
      <h2 id="st-sub" style={{ fontSize: 15, fontWeight: 700, margin: "0 0 8px" }}>{t("statusPage.subscribe")}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <a href={`/api/v1/public/status/${encodeURIComponent(slug)}/rss`} className="tg-link" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <Rss size={14} aria-hidden /> {t("statusPage.rss")}
        </a>
        {emailUpdates && (
          sub.isSuccess ? (
            <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--c-g)" }}>{t("statusPage.emailSent")}</p>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); sub.mutate(); }} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                type="email"
                required
                autoComplete="email"
                aria-label={t("statusPage.emailLabel")}
                placeholder={t("statusPage.emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ ...fieldStyle, flex: 1, minWidth: 200, width: "auto" }}
              />
              <Btn type="submit" loading={sub.isPending} disabled={!email}>{t("statusPage.emailCta")}</Btn>
              {sub.isError && <span role="alert" style={{ flexBasis: "100%", fontSize: 12, color: "var(--c-r)" }}>{t("statusPage.emailFailed")}</span>}
            </form>
          )
        )}
      </div>
    </section>
  );
}
