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
    const title = failed
      ? `Deploy failed — ${name}`
      : rolled
        ? `Deploy rolled back — ${name}`
        : `Deploy succeeded — ${name}`;
    const summary = failed
      ? `Deploy of ${name} failed.`
      : rolled
        ? `New version of ${name} failed its health check; the previous version is still live.`
        : `${name} deployed successfully.`;
    const appId = s(c, "appId");
    const links = [
      { label: "Open app", url: s(c, "url") },
      { label: "View in Tugra", url: appId ? `${env.webBaseUrl}/apps/${appId}` : "" },
    ].filter((l) => l.url);
    return base(ev, {
      level,
      title,
      summary,
      critical: failed,
      // The raw deploy log is intentionally NOT rendered here (it can carry secrets); the "View in
      // Tugra" link points at the access-controlled in-app deploy log instead.
      fields: fields([
        { label: "Project", value: s(c, "projectName"), inline: true },
        { label: "Environment", value: s(c, "environmentName"), inline: true },
        { label: "Duration", value: fmtDuration(num(c, "durationMs")), inline: true },
      ]),
      links,
    });
  },
};
