import { base, fields, fmtDate, s, type EventTemplate } from "../event";

/** Resource label + deep-link for a restore-verify event (always a database). */
function target(ev: { ctx: Record<string, unknown> }, env: { webBaseUrl: string; t: (k: string, p?: Record<string, string | number>) => string }) {
  const id = s(ev.ctx, "dbId");
  const link = id ? [{ label: env.t("backup.link.openDatabase"), url: `${env.webBaseUrl}/databases/${id}` }] : [];
  return { name: s(ev.ctx, "dbName"), link };
}

/** verify_missing — a verify-enabled database has run no restore-verify drill within its window (schedule stalled). */
export const verifyMissingTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const { name, link } = target(ev, env);
    return base(ev, {
      level: "failure",
      title: env.t("verify.missing.title", { name }),
      summary: env.t("verify.missing.summary", { name, hours: s(c, "windowHours") || "?" }),
      critical: true,
      fields: fields([
        { label: env.t("backup.field.engine"), value: [s(c, "engine"), s(c, "version")].filter(Boolean).join(" "), inline: true },
        { label: env.t("verify.field.lastVerified"), value: fmtDate(s(c, "lastVerifiedAt")) || env.t("backup.field.never"), inline: true },
        { label: env.t("backup.field.window"), value: s(c, "windowHours") ? `${s(c, "windowHours")}h` : "", inline: true },
      ]),
      links: link,
    });
  },
};

/** verify_recovered — the first successful restore-verify after a failed and/or missing verify alert. */
export const verifyRecoveredTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const { name, link } = target(ev, env);
    const after = s(c, "reason") === "missing" ? "missing" : "failed";
    return base(ev, {
      level: "success",
      title: env.t("verify.recovered.title", { name }),
      summary: env.t(`verify.recovered.after_${after}`, { name }),
      critical: false,
      fields: fields([
        { label: env.t("backup.field.engine"), value: [s(c, "engine"), s(c, "version")].filter(Boolean).join(" "), inline: true },
      ]),
      links: link,
    });
  },
};
