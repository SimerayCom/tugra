import { base, clamp, fields, s, type EventTemplate } from "../event";

/** backup_failed — a scheduled/on-demand database backup did not complete. */
export const backupFailedTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const dbName = s(c, "dbName");
    const dbId = s(c, "dbId");
    return base(ev, {
      level: "failure",
      title: env.t("backup.failed.title", { db: dbName }),
      summary: env.t("backup.failed.summary", { db: dbName }),
      critical: true,
      fields: fields([
        { label: env.t("backup.field.engine"), value: [s(c, "engine"), s(c, "version")].filter(Boolean).join(" "), inline: true },
        { label: env.t("backup.field.destination"), value: s(c, "destType"), inline: true },
        { label: env.t("backup.field.bucket"), value: s(c, "bucket"), inline: true },
        { label: env.t("backup.field.error"), value: clamp(s(c, "errorTail")) },
      ]),
      links: dbId ? [{ label: env.t("backup.link.openDatabase"), url: `${env.webBaseUrl}/databases/${dbId}` }] : [],
    });
  },
};

/** backup_restore_failed — restoring a backup into a database failed. */
export const restoreFailedTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const dbName = s(c, "dbName");
    const dbId = s(c, "dbId");
    return base(ev, {
      level: "failure",
      title: env.t("backup.restoreFailed.title", { db: dbName }),
      summary: env.t("backup.restoreFailed.summary", { db: dbName }),
      critical: true,
      fields: fields([
        { label: env.t("backup.field.engine"), value: s(c, "engine"), inline: true },
        { label: env.t("backup.field.exitCode"), value: s(c, "exitCode"), inline: true },
        { label: env.t("backup.field.error"), value: clamp(s(c, "errorTail")) },
      ]),
      links: dbId ? [{ label: env.t("backup.link.openDatabase"), url: `${env.webBaseUrl}/databases/${dbId}` }] : [],
    });
  },
};
