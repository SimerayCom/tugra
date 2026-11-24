import { base, clamp, fields, num, s, type EventTemplate } from "../event";
import { summaryLevel, type SummaryItem } from "../policy";
import type { MsgLevel } from "../rendered-message";

const LEVELS = new Set(["success", "failure", "warning", "info"]);

function readItems(v: unknown): SummaryItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => ({
      title: s(i, "title"),
      count: Math.max(1, num(i, "count")),
      level: (LEVELS.has(s(i, "level")) ? s(i, "level") : "info") as MsgLevel,
    }))
    .filter((i) => i.title !== "");
}

/**
 * alert_summary — the one message that replaces a burst of held alerts: repeats of the same alert inside the
 * dedupe window ("5 more times in the last 10 minutes"), alerts held during quiet hours, or alerts combined
 * because a channel hit its rate limit. Built by the queue service, never fired by a feature.
 */
export const alertSummaryTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const reason = s(c, "reason");
    const total = Math.max(1, num(c, "total"));
    const items = readItems(c.items);
    const more = num(c, "more");
    const minutes = Math.max(1, Math.round(num(c, "windowSec") / 60));
    const rows = fields([
      ...items.map((i) => ({ label: clamp(i.title, 200), value: `${i.count}×` })),
      { label: env.t("summary.field.more"), value: more > 0 ? String(more) : "" },
    ]);
    if (reason === "repeat") {
      const first = items[0];
      return base(ev, {
        level: first?.level ?? "info",
        title: env.t("summary.repeat.title", { title: first?.title ?? env.t("summary.repeat.fallback"), count: total }),
        summary: env.t(total === 1 ? "summary.repeat.summaryOne" : "summary.repeat.summary", { count: total, minutes }),
        fields: [],
        links: [],
      });
    }
    const key = reason === "quiet" ? "summary.quiet" : "summary.rate";
    return base(ev, {
      level: summaryLevel(items),
      title: env.t(`${key}.title`),
      summary: env.t(total === 1 ? `${key}.summaryOne` : `${key}.summary`, { count: total }),
      fields: rows,
      links: [],
    });
  },
};
