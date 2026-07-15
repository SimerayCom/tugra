import { base, fields, fmtDuration, num, s, type EventTemplate } from "../event";
import type { MsgLevel } from "../rendered-message";

/** deploy_success | deploy_rolled_back | deploy_failed — one template, branches on ev.type. */
export const deployTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const name = s(c, "appName");
    const failed = ev.type === "deploy_failed";
    const rolled = ev.type === "deploy_rolled_back";
    const level: MsgLevel = failed ? "failure" : rolled ? "warning" : "success";
    const key = failed ? "deploy.failed" : rolled ? "deploy.rolledBack" : "deploy.succeeded";
    const appId = s(c, "appId");
    const links = [
      { label: env.t("deploy.link.openApp"), url: s(c, "url") },
      { label: env.t("deploy.link.viewInTugra"), url: appId ? `${env.webBaseUrl}/apps/${appId}` : "" },
    ].filter((l) => l.url);
    return base(ev, {
      level,
      title: env.t(`${key}.title`, { app: name }),
      summary: env.t(`${key}.summary`, { app: name }),
      critical: failed,
      // The raw deploy log is intentionally NOT rendered here (it can carry secrets); the "View in
      // Tugra" link points at the access-controlled in-app deploy log instead.
      fields: fields([
        { label: env.t("deploy.field.project"), value: s(c, "projectName"), inline: true },
        { label: env.t("deploy.field.environment"), value: s(c, "environmentName"), inline: true },
        { label: env.t("deploy.field.duration"), value: fmtDuration(num(c, "durationMs")), inline: true },
      ]),
      links,
    });
  },
};
