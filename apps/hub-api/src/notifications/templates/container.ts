import { base, clamp, fields, num, s, type EventTemplate } from "../event";

/** container_crashed / container_oom / container_unhealthy — fired ONLY by the container-health poll
 *  (server-ops/container-health.*) on a TRANSITION, never on a steady state. crashed/oom are critical
 *  failures; unhealthy is a non-critical warning (the healthcheck is failing but the process is up). */
export const containerTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const oom = ev.type === "container_oom";
    const unhealthy = ev.type === "container_unhealthy";
    const label = s(c, "label") || s(c, "containerName");
    const server = s(c, "serverName") || s(c, "hostname");
    const kind = s(c, "kind");
    const resourceId = s(c, "resourceId");
    const restarts = num(c, "restartDelta");
    const reason = s(c, "reason");
    const link =
      kind === "app" && resourceId
        ? { label: env.t("container.link.openApp"), url: `${env.webBaseUrl}/apps/${resourceId}` }
        : kind === "db" && resourceId
          ? { label: env.t("container.link.openDatabase"), url: `${env.webBaseUrl}/databases/${resourceId}` }
          : { label: env.t("container.link.openServer"), url: `${env.webBaseUrl}/servers/${s(c, "serverId")}` };
    const titleKey = unhealthy ? "container.unhealthy.title" : oom ? "container.oom.title" : "container.crashed.title";
    const summaryKey = unhealthy ? "container.unhealthy.summary" : oom ? "container.oom.summary" : "container.crashed.summary";
    return base(ev, {
      level: unhealthy ? "warning" : "failure",
      critical: !unhealthy,
      title: env.t(titleKey, { container: clamp(label, 120), server: clamp(server, 120) }),
      summary: env.t(summaryKey, { container: clamp(label, 120) }),
      fields: fields(
        unhealthy
          ? [
              { label: env.t("container.field.server"), value: clamp(server, 200), inline: true },
              { label: env.t("container.field.container"), value: clamp(label, 200), inline: true },
              { label: env.t("container.field.status"), value: env.t("container.unhealthy.state"), inline: true },
            ]
          : [
              { label: env.t("container.field.server"), value: clamp(server, 200), inline: true },
              { label: env.t("container.field.container"), value: clamp(label, 200), inline: true },
              { label: env.t("container.field.exitCode"), value: oom ? "OOM" : String(num(c, "exitCode")), inline: true },
              { label: env.t("container.field.restarts"), value: restarts > 0 ? String(restarts) : "", inline: true },
              { label: env.t("container.field.reason"), value: reason ? clamp(reason, 200) : "", inline: true },
            ],
      ),
      links: [link],
    });
  },
};
