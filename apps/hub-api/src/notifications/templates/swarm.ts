import { base, fields, num, s, type EventTemplate } from "../event";

/** swarm_degraded — fired ONLY by SwarmSchedulerService's periodic poll (clusters/swarm.scheduler.service.ts)
 *  on a real ACTIVE→DEGRADED edge, never from the interactive SwarmService.status() a human triggers. */
export const swarmDegradedTemplate: EventTemplate = {
  render(ev, env) {
    const c = ev.ctx;
    const name = s(c, "clusterName");
    const clusterId = s(c, "clusterId");
    return base(ev, {
      level: "failure",
      title: env.t("swarm.degraded.title", { cluster: name }),
      summary: env.t("swarm.degraded.summary", { cluster: name }),
      critical: true,
      fields: fields([
        { label: env.t("swarm.field.nodesReady"), value: `${num(c, "readyCount")}/${num(c, "joinedCount")}`, inline: true },
      ]),
      links: clusterId ? [{ label: env.t("swarm.link.openCluster"), url: `${env.webBaseUrl}/clusters/${clusterId}` }] : [],
    });
  },
};
