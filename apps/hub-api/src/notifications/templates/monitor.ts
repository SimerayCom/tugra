import { base, clamp, fields, num, s, type EventTemplate } from "../event";

/** monitor_up | monitor_down — one template, direction from ev.type (derived from ctx.status). */
export const monitorTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const name = s(c, "monitorName");
    const target = s(c, "target");
    const up = ev.type === "monitor_up";
    const monitorId = s(c, "monitorId");
    const dir = up ? "monitor.up" : "monitor.down";
    return base(ev, {
      level: up ? "success" : "failure",
      title: env.t(`${dir}.title`, { monitor: name }),
      summary: env.t(`${dir}.summary`, { monitor: name, target }),
      critical: !up,
      fields: fields([
        { label: env.t("monitor.field.target"), value: target, inline: true },
        { label: env.t("monitor.field.type"), value: s(c, "monitorType"), inline: true },
        { label: env.t("monitor.field.response"), value: c.responseMs == null ? "" : env.t("monitor.value.ms", { ms: num(c, "responseMs") }), inline: true },
        { label: env.t("monitor.field.detail"), value: clamp(s(c, "resultMsg")) },
      ]),
      links: monitorId ? [{ label: env.t("monitor.link.viewMonitor"), url: `${env.webBaseUrl}/monitors/${monitorId}` }] : [],
    });
  },
};
