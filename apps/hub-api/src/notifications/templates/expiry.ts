import { base, fields, fmtDate, num, s, type EventTemplate } from "../event";

/** ssl_expiring — a domain's TLS certificate is within the notify window. */
export const sslExpiringTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const domain = s(c, "domain");
    const appId = s(c, "appId");
    const days = num(c, "days");
    return base(ev, {
      level: "warning",
      title: `SSL certificate expiring — ${domain}`,
      summary: `The TLS certificate for ${domain} expires in ${days} day(s).`,
      fields: fields([
        { label: "Domain", value: domain, inline: true },
        { label: "Expires in", value: `${days} day(s)`, inline: true },
        { label: "Expiry", value: fmtDate(s(c, "validTo")), inline: true },
        { label: "Issuer", value: s(c, "issuer"), inline: true },
      ]),
      links: appId ? [{ label: "Open app", url: `${env.webBaseUrl}/apps/${appId}` }] : [],
    });
  },
};

/** token_expiring — an API token is within the notify window. */
export const tokenExpiringTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const tokenName = s(c, "tokenName");
    const days = num(c, "days");
    return base(ev, {
      level: "warning",
      title: `API token expiring — ${tokenName}`,
      summary: `API token "${tokenName}" expires in ${days} day(s).`,
      fields: fields([
        { label: "Token", value: tokenName, inline: true },
        { label: "Expires in", value: `${days} day(s)`, inline: true },
        { label: "Expiry", value: fmtDate(s(c, "expiresAt")), inline: true },
      ]),
      links: [{ label: "Manage tokens", url: `${env.webBaseUrl}/settings` }],
    });
  },
};
