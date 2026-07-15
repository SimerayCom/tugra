import { base, fields, fmtBytes, num, s, type EventTemplate } from "../event";

/** volume_backup_success / volume_backup_failed — an app's named-volume backup run finished.
 *  One event per `runBackup` (aggregated over all volumes); a partial failure reports as failed. */
export const volumeBackupTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const app = s(c, "appName");
    const appId = s(c, "appId");
    const failed = ev.type === "volume_backup_failed";
    return base(ev, {
      level: failed ? "failure" : "success",
      title: env.t(failed ? "volumeBackup.failed.title" : "volumeBackup.succeeded.title", { app }),
      summary: env.t(failed ? "volumeBackup.failed.summary" : "volumeBackup.succeeded.summary", { app }),
      critical: failed,
      fields: fields([
        { label: env.t("volumeBackup.field.volumes"), value: s(c, "volumes"), inline: true },
        { label: env.t("volumeBackup.field.destination"), value: s(c, "destType"), inline: true },
        { label: env.t("volumeBackup.field.bucket"), value: s(c, "bucket"), inline: true },
        { label: env.t("volumeBackup.field.size"), value: fmtBytes(num(c, "sizeBytes")), inline: true },
        { label: env.t("volumeBackup.field.failedVolumes"), value: s(c, "failedVolumes") },
      ]),
      links: appId ? [{ label: env.t("volumeBackup.link.openApp"), url: `${env.webBaseUrl}/apps/${appId}` }] : [],
    });
  },
};
