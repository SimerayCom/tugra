import { base, fields, fmtDate, s, type EventTemplate } from "../event";

/** Resource label + deep-link for a backup-health event (database vs app-volume backups share the events). */
function target(ev: { ctx: Record<string, unknown> }, env: { webBaseUrl: string; t: (k: string, p?: Record<string, string | number>) => string }) {
  const c = ev.ctx;
  const volume = s(c, "kind") === "volume";
  const name = volume ? s(c, "appName") : s(c, "dbName");
  const id = volume ? s(c, "appId") : s(c, "dbId");
  const link = id
    ? [{ label: volume ? env.t("backup.link.openApp") : env.t("backup.link.openDatabase"), url: `${env.webBaseUrl}/${volume ? "apps" : "databases"}/${id}` }]
    : [];
  return { volume, name, link };
}

/** backup_missing — a backup-enabled resource has had no SUCCESS backup within its window (schedule stalled/failing). */
export const backupMissingTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const { volume, name, link } = target(ev, env);
    return base(ev, {
      level: "failure",
      title: env.t(volume ? "backup.missing.volumeTitle" : "backup.missing.title", { name }),
      summary: env.t(volume ? "backup.missing.volumeSummary" : "backup.missing.summary", { name, hours: s(c, "windowHours") || "?" }),
      critical: true,
      fields: fields([
        { label: env.t("backup.field.engine"), value: [s(c, "engine"), s(c, "version")].filter(Boolean).join(" "), inline: true },
        { label: env.t("backup.field.lastSuccess"), value: fmtDate(s(c, "lastSuccessAt")) || env.t("backup.field.never"), inline: true },
        { label: env.t("backup.field.window"), value: s(c, "windowHours") ? `${s(c, "windowHours")}h` : "", inline: true },
      ]),
      links: link,
    });
  },
};

/** backup_recovered — the first SUCCESS after a notified failure and/or a backup_missing alert. */
export const backupRecoveredTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const { volume, name, link } = target(ev, env);
    const after = s(c, "reason") === "missing" ? "missing" : "failed";
    return base(ev, {
      level: "success",
      title: env.t(volume ? "backup.recovered.volumeTitle" : "backup.recovered.title", { name }),
      summary: env.t(`backup.recovered.after_${after}`, { name }),
      critical: false,
      fields: fields([
        { label: env.t("backup.field.engine"), value: [s(c, "engine"), s(c, "version")].filter(Boolean).join(" "), inline: true },
      ]),
      links: link,
    });
  },
};
