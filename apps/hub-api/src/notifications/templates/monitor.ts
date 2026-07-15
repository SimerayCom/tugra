import { base, clamp, fields, num, s, type EventTemplate } from "../event";

/** monitor_up | monitor_down — one template, direction from ev.type (derived from ctx.status). */
export const monitorTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const name = s(c, "monitorName");
    const target = s(c, "target");
    const up = ev.type === "monitor_up";
    const monitorId = s(c, "monitorId");
    return base(ev, {
      level: up ? "success" : "failure",
      title: up ? `Monitor recovered — ${name}` : `Monitor down — ${name}`,
      summary: up ? `${name} (${target}) is back UP.` : `${name} (${target}) is DOWN.`,
      critical: !up,
      fields: fields([
        { label: "Target", value: target, inline: true },
        { label: "Type", value: s(c, "monitorType"), inline: true },
        { label: "Response", value: c.responseMs == null ? "" : `${num(c, "responseMs")} ms`, inline: true },
        { label: "Detail", value: clamp(s(c, "resultMsg")) },
      ]),
      links: monitorId ? [{ label: "View monitor", url: `${env.webBaseUrl}/monitors/${monitorId}` }] : [],
    });
  },
};
