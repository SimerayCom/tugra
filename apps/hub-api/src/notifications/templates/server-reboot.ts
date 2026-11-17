import { base, fields, s, num, type EventTemplate } from "../event";
import type { MsgLevel } from "../rendered-message";

/** server_reboot_verified | server_reboot_degraded | server_reboot_failed — one template, branches on ev.type.
 *  ctx: serverId, serverName, reason (a closed failure code), containersOk/Expected, domainsOk/Expected, rebootRequired
 *  ("yes" when the host still asks for a reboot), problems (a short comma list of container/domain names), problemCount.
 *  Only names, counts and stable codes: never command output. */
export const serverRebootTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const kind = ev.type === "server_reboot_verified" ? "verified" : ev.type === "server_reboot_degraded" ? "degraded" : "failed";
    const name = s(c, "serverName");
    const serverId = s(c, "serverId");
    const reasonKey = s(c, "reason");
    const reason = reasonKey ? env.t(`serverReboot.reason.${reasonKey}`) : "";
    const params = {
      server: name,
      containersOk: num(c, "containersOk"),
      containersTotal: num(c, "containersExpected"),
      domainsOk: num(c, "domainsOk"),
      domainsTotal: num(c, "domainsExpected"),
      reason,
    };
    const level: MsgLevel = kind === "verified" ? "success" : kind === "degraded" ? "warning" : "failure";
    const problemCount = num(c, "problemCount");
    return base(ev, {
      level,
      title: env.t(`serverReboot.${kind}.title`, params),
      summary: env.t(`serverReboot.${kind}.summary`, params),
      // a failed reboot (the host did not come back / did not reboot) needs a human now
      critical: kind === "failed",
      fields: fields([
        { label: env.t("serverReboot.field.containers"), value: kind === "failed" ? "" : `${num(c, "containersOk")}/${num(c, "containersExpected")}`, inline: true },
        { label: env.t("serverReboot.field.domains"), value: kind === "failed" ? "" : `${num(c, "domainsOk")}/${num(c, "domainsExpected")}`, inline: true },
        { label: env.t("serverReboot.field.reason"), value: kind === "failed" ? reason : "" },
        { label: env.t("serverReboot.field.problems", { count: problemCount }), value: kind === "verified" ? "" : s(c, "problems") },
        { label: env.t("serverReboot.field.rebootRequired"), value: s(c, "rebootRequired") === "yes" ? env.t("serverReboot.stillRequired") : "" },
      ]),
      links: serverId ? [{ label: env.t("serverReboot.link.openServer"), url: `${env.webBaseUrl}/servers/${serverId}` }] : [],
    });
  },
};
