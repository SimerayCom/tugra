import { base, fields, num, s, type EventTemplate } from "../event";
import type { MsgLevel } from "../rendered-message";

/** rollout_halted | rollout_completed | rollout_rolled_back | rollout_rollback_failed — one template, branches
 *  on ev.type. ctx: rolloutId, name, wave (1-based current), waves, passed, failed, total, reason (halt only). */
export const rolloutTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const name = s(c, "name") || s(c, "rolloutId").slice(0, 6);
    const kind =
      ev.type === "rollout_halted" ? "halted" : ev.type === "rollout_rolled_back" ? "rolledBack" : ev.type === "rollout_rollback_failed" ? "rollbackFailed" : "completed";
    const level: MsgLevel = kind === "completed" || kind === "rolledBack" ? "success" : kind === "halted" ? "warning" : "failure";
    const reasonKey = s(c, "reason");
    const reason = reasonKey ? env.t(`rollout.reason.${reasonKey}`) : "";
    const params = { name, wave: num(c, "wave"), waves: num(c, "waves"), passed: num(c, "passed"), failed: num(c, "failed"), total: num(c, "total"), reverted: num(c, "reverted"), skipped: num(c, "skipped"), reason };
    const rolloutId = s(c, "rolloutId");
    return base(ev, {
      level,
      title: env.t(`rollout.${kind}.title`, params),
      summary: env.t(`rollout.${kind}.summary`, params),
      // A system halt needs a human (a failed wave, an interrupted deploy); an operator who halted already knows.
      critical: kind === "rollbackFailed" || (kind === "halted" && reasonKey !== "manual"),
      fields: fields([
        { label: env.t("rollout.field.wave"), value: num(c, "waves") ? `${num(c, "wave")}/${num(c, "waves")}` : "", inline: true },
        { label: env.t("rollout.field.passed"), value: String(num(c, "passed")), inline: true },
        { label: env.t("rollout.field.failed"), value: num(c, "failed") ? String(num(c, "failed")) : "", inline: true },
        { label: env.t("rollout.field.reverted"), value: num(c, "reverted") ? String(num(c, "reverted")) : "", inline: true },
        { label: env.t("rollout.field.skipped"), value: num(c, "skipped") ? String(num(c, "skipped")) : "", inline: true },
        { label: env.t("rollout.field.total"), value: String(num(c, "total")), inline: true },
      ]),
      links: rolloutId ? [{ label: env.t("rollout.link.open"), url: `${env.webBaseUrl}/rollouts/${rolloutId}` }] : [],
    });
  },
};
