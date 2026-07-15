import { base, clamp, fields, s, type EventTemplate } from "../event";

/** backup_failed — a scheduled/on-demand database backup did not complete. */
export const backupFailedTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const dbName = s(c, "dbName");
    const dbId = s(c, "dbId");
    return base(ev, {
      level: "failure",
      title: `Backup failed — ${dbName}`,
      summary: `A backup of ${dbName} failed.`,
      critical: true,
      fields: fields([
        { label: "Engine", value: [s(c, "engine"), s(c, "version")].filter(Boolean).join(" "), inline: true },
        { label: "Destination", value: s(c, "destType"), inline: true },
        { label: "Bucket", value: s(c, "bucket"), inline: true },
        { label: "Error", value: clamp(s(c, "errorTail")) },
      ]),
      links: dbId ? [{ label: "Open database", url: `${env.webBaseUrl}/databases/${dbId}` }] : [],
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
      title: `Restore failed — ${dbName}`,
      summary: `A restore into ${dbName} failed.`,
      critical: true,
      fields: fields([
        { label: "Engine", value: s(c, "engine"), inline: true },
        { label: "Exit code", value: s(c, "exitCode"), inline: true },
        { label: "Error", value: clamp(s(c, "errorTail")) },
      ]),
      links: dbId ? [{ label: "Open database", url: `${env.webBaseUrl}/databases/${dbId}` }] : [],
    });
  },
};
