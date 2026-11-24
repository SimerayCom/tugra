import { base, fields, num, s, type EventTemplate } from "../event";
import type { MsgLink } from "../rendered-message";

interface Suggestion {
  code: string;
  params: Record<string, string | number>;
}

function readSuggestions(v: unknown): Suggestion[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => {
      const params: Record<string, string | number> = {};
      if (i.params && typeof i.params === "object") {
        for (const [k, val] of Object.entries(i.params as Record<string, unknown>)) {
          if (typeof val === "string" || typeof val === "number") params[k] = val;
        }
      }
      return { code: s(i, "code"), params };
    })
    .filter((x) => /^[a-z_]+$/.test(x.code));
}

/** weekly_digest — a team's last seven days: deploys, backups, incidents, busiest server and a few suggestions. */
export const weeklyDigestTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const deploys = (c.deploys ?? {}) as Record<string, unknown>;
    const backups = (c.backups ?? {}) as Record<string, unknown>;
    const busiest = (c.busiestServer ?? null) as Record<string, unknown> | null;
    const dTotal = num(deploys, "total");
    const dFailed = num(deploys, "failed");
    const bTotal = num(backups, "total");
    const bFailed = num(backups, "failed");
    const incidents = num(c, "incidents");
    const suggestions = readSuggestions(c.suggestions);

    const deployLine = dTotal === 0 ? env.t("digest.deploys.none") : dFailed > 0 ? env.t("digest.deploys.withFailures", { total: dTotal, failed: dFailed }) : env.t("digest.deploys.ok", { total: dTotal });
    const backupLine = bTotal === 0 ? env.t("digest.backups.none") : bFailed > 0 ? env.t("digest.backups.withFailures", { total: bTotal, failed: bFailed }) : env.t("digest.backups.ok", { total: bTotal });
    const bits = [deployLine, backupLine];
    if (busiest && s(busiest, "name")) bits.push(env.t("digest.busiest.summary", { name: s(busiest, "name") }));

    const links: MsgLink[] = [{ label: env.t("digest.link.open"), url: `${env.webBaseUrl}/` }];
    return base(ev, {
      level: dFailed > 0 || bFailed > 0 || incidents > 0 ? "warning" : "success",
      title: env.t("digest.title", { team: s(c, "teamName") || "Tugra" }),
      summary: bits.join(" · "),
      fields: fields([
        { label: env.t("digest.field.deploys"), value: deployLine, inline: true },
        { label: env.t("digest.field.backups"), value: backupLine, inline: true },
        { label: env.t("digest.field.incidents"), value: String(incidents), inline: true },
        {
          label: env.t("digest.field.busiest"),
          value: busiest && s(busiest, "name") ? env.t("digest.busiest.value", { name: s(busiest, "name"), cpu: Math.round(num(busiest, "cpuPct")) }) : "",
          inline: true,
        },
        {
          label: env.t("digest.field.suggestions"),
          value: suggestions.map((x) => `• ${env.t(`digest.suggestion.${x.code}`, x.params)}`).join("\n"),
        },
      ]),
      links,
    });
  },
};
