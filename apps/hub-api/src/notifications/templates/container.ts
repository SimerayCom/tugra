import { base, clamp, fields, num, s, type EventTemplate } from "../event";

/** container_crashed / container_oom — fired ONLY by the container-health poll
 *  (server-ops/container-health.*) on a crash/OOM TRANSITION, never on a steady state. */
export const containerTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const oom = ev.type === "container_oom";
    const label = s(c, "label") || s(c, "containerName");
    const server = s(c, "serverName") || s(c, "hostname");
    const kind = s(c, "kind");
    const resourceId = s(c, "resourceId");
    const restarts = num(c, "restartDelta");
    const link =
      kind === "app" && resourceId
        ? { label: env.t("container.link.openApp"), url: `${env.webBaseUrl}/apps/${resourceId}` }
        : kind === "db" && resourceId
          ? { label: env.t("container.link.openDatabase"), url: `${env.webBaseUrl}/databases/${resourceId}` }
          : { label: env.t("container.link.openServer"), url: `${env.webBaseUrl}/servers/${s(c, "serverId")}` };
    return base(ev, {
      level: "failure",
      critical: true,
      title: env.t(oom ? "container.oom.title" : "container.crashed.title", { container: clamp(label, 120), server: clamp(server, 120) }),
      summary: env.t(oom ? "container.oom.summary" : "container.crashed.summary", { container: clamp(label, 120) }),
      fields: fields([
        { label: env.t("container.field.server"), value: clamp(server, 200), inline: true },
        { label: env.t("container.field.container"), value: clamp(label, 200), inline: true },
        { label: env.t("container.field.exitCode"), value: oom ? "OOM" : String(num(c, "exitCode")), inline: true },
        { label: env.t("container.field.restarts"), value: restarts > 0 ? String(restarts) : "", inline: true },
      ]),
      links: [link],
    });
  },
};
