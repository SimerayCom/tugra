/**
 * Self-heal for compose members deployed before Tugra stamped a default restart policy (pure builders, no Nest I/O).
 *
 * A stack deployed by an older hub has members with RestartPolicy "no" that a Docker restart / reboot leaves down; the
 * deploy-time fix (deploy/compose-restart.ts) only reaches them on their next deploy. This builds the one idempotent
 * host command that closes the gap without a redeploy: `docker update --restart unless-stopped` on the live containers
 * of the members the hub's stored compose file leaves without any restart key.
 *
 * Safe because:
 *  - the member list comes from composeRestartServices(): an explicit `restart` (including "no"), a
 *    `deploy.restart_policy`, an init / one-shot member and a compose job are NEVER in it;
 *  - only a container whose policy is currently "no" / empty is touched (running it twice changes nothing);
 *  - `docker update` never starts, stops or recreates a container (an exited member stays exited, a manual stop holds);
 *  - compose one-off containers (`docker compose run`, oneoff=True) are skipped;
 *  - project and service names are validated here, so nothing user-shaped reaches the shell unquoted.
 */

import { composeRestartServices, DEFAULT_COMPOSE_RESTART } from "../deploy/compose-restart";

export const HEAL_MARKER = "TUGRA_RESTART_HEALED";
const PROJECT_RE = /^tugra_[A-Za-z0-9]+$/;
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The members to heal for one stored-compose app: [] for an app whose YAML is not on the hub (git-compose). */
export interface HealTarget {
  project: string;
  services: string[];
}

/** The heal targets of the given apps. A git-compose app (YAML lives in the clone, not on the hub) and an app with
 *  nothing to heal are left out: they get the policy on their next deploy. */
export function healTargetsFor(apps: { id: string; composeFile: string | null; gitUrl: string | null; composePath: string | null }[]): HealTarget[] {
  const out: HealTarget[] = [];
  for (const a of apps) {
    if (a.gitUrl && a.composePath) continue;
    const services = composeRestartServices(a.composeFile);
    const project = `tugra_${a.id}`;
    if (services.length === 0 || !PROJECT_RE.test(project)) continue;
    out.push({ project, services });
  }
  return out;
}

/** One `docker update` pass over the targets (read-mostly; exits 0 even when nothing needed healing). */
export function buildComposeRestartHealScript(targets: HealTarget[]): string {
  const lines = [
    "set -u",
    // heal <project> <service>: every non-one-off container of that member whose restart policy is "no"/empty.
    `heal() { for c in $(docker ps -aq --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=$2" --filter "label=com.docker.compose.oneoff=False" 2>/dev/null); do p=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null) || continue; case "$p" in ""|no) docker update --restart ${DEFAULT_COMPOSE_RESTART} "$c" >/dev/null 2>&1 && echo "${HEAL_MARKER} $1 $2";; esac; done; }`,
  ];
  for (const t of targets) {
    if (!PROJECT_RE.test(t.project)) continue;
    for (const s of t.services) if (SERVICE_RE.test(s)) lines.push(`heal ${t.project} ${s}`);
  }
  lines.push("exit 0");
  return lines.join("\n");
}

/** How many containers the script healed (count of marker lines). */
export function parseHealed(output: string): number {
  return output.split("\n").filter((l) => l.startsWith(`${HEAL_MARKER} `)).length;
}
