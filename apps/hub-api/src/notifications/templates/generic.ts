import { asLevel, base, s, type EventTemplate } from "../event";
import type { MsgField, MsgLink } from "../rendered-message";

/** Fallback for any event id not in the registry — reads a best-effort shape from ctx. */
export const genericTemplate: EventTemplate = {
  render(ev) {
    const c = ev.ctx;
    const title = s(c, "title") || ev.type;
    const summary = s(c, "summary") || s(c, "message") || title;
    const raw = Array.isArray(c.fields) ? c.fields : [];
    const fieldList: MsgField[] = raw
      .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
      .map((f) => {
        const label = s(f, "label");
        const value = s(f, "value");
        return f.inline ? { label, value, inline: true } : { label, value };
      })
      .filter((f) => f.label !== "" && f.value !== "");
    const url = s(c, "url");
    const links: MsgLink[] = url ? [{ label: "Open", url }] : [];
    return base(ev, {
      level: asLevel(s(c, "level")),
      title,
      summary,
      critical: Boolean(c.critical),
      fields: fieldList,
      links,
    });
  },
};
