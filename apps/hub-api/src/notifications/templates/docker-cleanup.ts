import { base, clamp, fields, s, type EventTemplate } from "../event";

/** docker_cleanup_success / docker_cleanup_failed — a `docker system prune` maintenance run finished.
 *  Never critical (@here): maintenance, self-healing on the next cycle even when it fails. */
export const dockerCleanupTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const server = s(c, "serverName");
    const serverId = s(c, "serverId");
    const failed = ev.type === "docker_cleanup_failed";
    return base(ev, {
      level: failed ? "failure" : "success",
      title: env.t(failed ? "dockerCleanup.failed.title" : "dockerCleanup.succeeded.title", { server }),
      summary: env.t(failed ? "dockerCleanup.failed.summary" : "dockerCleanup.succeeded.summary", { server }),
      critical: false,
      fields: fields([
        { label: env.t("dockerCleanup.field.reclaimed"), value: s(c, "reclaimed"), inline: true },
        { label: env.t("dockerCleanup.field.error"), value: clamp(s(c, "errorTail")) },
      ]),
      links: serverId ? [{ label: env.t("dockerCleanup.link.openServer"), url: `${env.webBaseUrl}/servers/${serverId}` }] : [],
    });
  },
};
