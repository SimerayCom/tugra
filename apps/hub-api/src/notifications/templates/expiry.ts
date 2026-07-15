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
      title: env.t("expiry.ssl.title", { domain }),
      summary: env.t("expiry.ssl.summary", { domain, days }),
      fields: fields([
        { label: env.t("expiry.field.domain"), value: domain, inline: true },
        { label: env.t("expiry.field.expiresIn"), value: env.t("expiry.value.days", { days }), inline: true },
        { label: env.t("expiry.field.expiry"), value: fmtDate(s(c, "validTo")), inline: true },
        { label: env.t("expiry.field.issuer"), value: s(c, "issuer"), inline: true },
      ]),
      links: appId ? [{ label: env.t("expiry.link.openApp"), url: `${env.webBaseUrl}/apps/${appId}` }] : [],
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
      title: env.t("expiry.token.title", { token: tokenName }),
      summary: env.t("expiry.token.summary", { token: tokenName, days }),
      fields: fields([
        { label: env.t("expiry.field.token"), value: tokenName, inline: true },
        { label: env.t("expiry.field.expiresIn"), value: env.t("expiry.value.days", { days }), inline: true },
        { label: env.t("expiry.field.expiry"), value: fmtDate(s(c, "expiresAt")), inline: true },
      ]),
      links: [{ label: env.t("expiry.link.manageTokens"), url: `${env.webBaseUrl}/settings` }],
    });
  },
};
