import { base, fields, s, type EventTemplate } from "../event";

/** scheduled_task_success / scheduled_task_failed — a scheduled task inside an app container ran.
 *  The command's raw output is deliberately NOT shown: a scheduled task is an arbitrary user command
 *  that can print secrets. Operators inspect the run via the access-controlled openApp deep-link. */
export const scheduledTaskTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const task = s(c, "taskName");
    const app = s(c, "appName");
    const appId = s(c, "appId");
    const failed = ev.type === "scheduled_task_failed";
    return base(ev, {
      level: failed ? "failure" : "success",
      title: env.t(failed ? "scheduledTask.failed.title" : "scheduledTask.succeeded.title", { task }),
      summary: env.t(failed ? "scheduledTask.failed.summary" : "scheduledTask.succeeded.summary", { task, app }),
      critical: failed,
      fields: fields([
        { label: env.t("scheduledTask.field.app"), value: app, inline: true },
        { label: env.t("scheduledTask.field.exitCode"), value: s(c, "exitCode"), inline: true },
      ]),
      links: appId ? [{ label: env.t("scheduledTask.link.openApp"), url: `${env.webBaseUrl}/apps/${appId}` }] : [],
    });
  },
};
