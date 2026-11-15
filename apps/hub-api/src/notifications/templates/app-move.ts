import { base, fields, s, type EventTemplate } from "../event";
import type { MsgLevel } from "../rendered-message";

/** app_move_completed | app_move_rolled_back | app_move_failed — one template, branches on ev.type. ctx: appId, appName,
 *  sourceName, targetName, reason (a failureReason code), archiveUntil (ISO, completed only), retainDays. Only names and
 *  stable codes: never a signed relay path, a key, or script output. */
export const appMoveTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const kind = ev.type === "app_move_rolled_back" ? "rolledBack" : ev.type === "app_move_failed" ? "failed" : "completed";
    const app = s(c, "appName") || s(c, "appId");
    const reasonKey = s(c, "reason");
    const reason = reasonKey ? env.t(`appMove.reason.${reasonKey}`) : "";
    const until = s(c, "archiveUntil").slice(0, 10);
    const params = { app, source: s(c, "sourceName"), target: s(c, "targetName"), reason, until };
    const level: MsgLevel = kind === "completed" ? "success" : kind === "rolledBack" ? "warning" : "failure";
    const appId = s(c, "appId");
    const summaryKey = kind === "completed" && !until ? "appMove.completed.summaryNoArchive" : `appMove.${kind}.summary`;
    return base(ev, {
      level,
      title: env.t(`appMove.${kind}.title`, params),
      summary: env.t(summaryKey, params),
      // a move that could not even restore the app on its original server needs a human now
      critical: kind === "failed",
      fields: fields([
        { label: env.t("appMove.field.source"), value: s(c, "sourceName"), inline: true },
        { label: env.t("appMove.field.target"), value: s(c, "targetName"), inline: true },
        { label: env.t("appMove.field.reason"), value: kind === "completed" ? "" : reason },
        { label: env.t("appMove.field.archiveUntil"), value: kind === "completed" ? until : "", inline: true },
      ]),
      links: appId ? [{ label: env.t("appMove.link.openApp"), url: `${env.webBaseUrl}/apps/${appId}` }] : [],
    });
  },
};
