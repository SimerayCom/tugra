import { base, fields, fmtDate, s, type EventTemplate } from "../event";

/** server_online — the agent reconnected and the server recovered from OFFLINE. */
export const serverOnlineTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const name = s(c, "serverName");
    const serverId = s(c, "serverId");
    return base(ev, {
      level: "success",
      title: env.t("server.online.title", { server: name }),
      summary: env.t("server.online.summary", { server: name }),
      critical: false,
      fields: fields([
        { label: env.t("server.field.hostname"), value: s(c, "hostname"), inline: true },
        { label: env.t("server.field.ip"), value: s(c, "publicIp"), inline: true },
      ]),
      links: serverId ? [{ label: env.t("server.link.openServer"), url: `${env.webBaseUrl}/servers/${serverId}` }] : [],
    });
  },
};

/** server_offline — the agent stopped reporting and the server was marked offline. */
export const serverOfflineTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const name = s(c, "serverName");
    const serverId = s(c, "serverId");
    return base(ev, {
      level: "failure",
      title: env.t("server.offline.title", { server: name }),
      summary: env.t("server.offline.summary", { server: name }),
      critical: true,
      fields: fields([
        { label: env.t("server.field.hostname"), value: s(c, "hostname"), inline: true },
        { label: env.t("server.field.lastSeen"), value: fmtDate(s(c, "lastSeenAt")), inline: true },
        { label: env.t("server.field.ip"), value: s(c, "publicIp"), inline: true },
      ]),
      links: serverId ? [{ label: env.t("server.link.openServer"), url: `${env.webBaseUrl}/servers/${serverId}` }] : [],
    });
  },
};

/** hub_outage — the hub's own dead-man check-in went silent (a gap in its heartbeat) or keeps failing. */
export const hubOutageTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const gap = s(c, "kind") === "gap";
    const minutes = s(c, "minutes");
    return base(ev, {
      level: "failure",
      title: env.t("server.hubOutage.title"),
      summary: env.t("server.hubOutage.summary", { detail: gap ? env.t("server.hubOutage.gap", { minutes }) : env.t("server.hubOutage.failing") }),
      critical: true,
      fields: fields([
        { label: env.t("server.hubOutage.field.silent"), value: gap && minutes ? `${minutes} min` : "", inline: true },
        { label: env.t("server.hubOutage.field.failures"), value: gap ? "" : s(c, "failures"), inline: true },
      ]),
      links: [],
    });
  },
};
