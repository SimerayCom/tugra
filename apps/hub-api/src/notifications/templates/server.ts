import { base, fields, fmtDate, s, type EventTemplate } from "../event";

/** server_offline — the agent stopped reporting and the server was marked offline. */
export const serverOfflineTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const name = s(c, "serverName");
    const serverId = s(c, "serverId");
    return base(ev, {
      level: "failure",
      title: `Server offline — ${name}`,
      summary: `Server ${name} stopped responding.`,
      critical: true,
      fields: fields([
        { label: "Hostname", value: s(c, "hostname"), inline: true },
        { label: "Last seen", value: fmtDate(s(c, "lastSeenAt")), inline: true },
        { label: "IP", value: s(c, "publicIp"), inline: true },
      ]),
      links: serverId ? [{ label: "Open server", url: `${env.webBaseUrl}/servers/${serverId}` }] : [],
    });
  },
};
