/**
 * Restart policy for the members of a COMPOSE stack (pure, no Nest I/O).
 *
 * Compose gives a service NO restart policy unless the file sets one, so a stack whose template forgot `restart:`
 * stays down after the Docker daemon restarts (an OS update upgrading docker-ce) or the host reboots. Tugra's own
 * apps, databases and proxy run `--restart unless-stopped`; a compose member must too. {@link composeRestartServices}
 * decides which members Tugra stamps with it, and the callers write that into the Tugra override file (merged over
 * the user's YAML, which is never rewritten).
 *
 * A member is left ALONE when it
 *  - already carries a `restart` key (any value, `"no"` included: an explicit choice by the template or the user),
 *    directly, via `deploy.restart_policy` (compose honours it when `restart` is absent), or via an in-file `extends`;
 *  - is an init / one-shot member: another service waits for it with `condition: service_completed_successfully`
 *    (it is designed to exit; a restart policy would loop it), or is a compose job (`deploy.mode: *-job`).
 */

import { parse } from "yaml";

/** The policy injected into a member that sets none. */
export const DEFAULT_COMPOSE_RESTART = "unless-stopped";

/** A compose service key Tugra will write into the override as a YAML mapping key. Anything else is left out, so a
 *  hostile key can never reach the override text. */
const SERVICE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Def = Record<string, unknown>;

function asObject(v: unknown): Def | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Def) : null;
}

/** `extends: base` (string) or `extends: { service: base, file?: ... }`. */
function extendsTarget(def: Def): { service: string; file: boolean } | null {
  const ex = def.extends;
  if (typeof ex === "string") return { service: ex, file: false };
  const o = asObject(ex);
  if (o && typeof o.service === "string") return { service: o.service, file: o.file != null };
  return null;
}

/** True when the service (directly, or through an in-file `extends` chain) already states a restart policy. A
 *  `restart: null` is "not set". An `extends` of another FILE cannot be seen from here, so it counts as set. */
function setsRestart(name: string, services: Record<string, unknown>, seen: Set<string>): boolean {
  if (seen.has(name)) return false; // cycle: compose rejects it anyway
  seen.add(name);
  const def = asObject(services[name]);
  if (!def) return false;
  if (def.restart !== undefined && def.restart !== null) return true;
  const deploy = asObject(def.deploy);
  if (deploy && deploy.restart_policy != null) return true;
  const ex = extendsTarget(def);
  if (ex) {
    if (ex.file) return true;
    return setsRestart(ex.service, services, seen);
  }
  return false;
}

/** Services another service waits on to COMPLETE (init / migration members): they exit by design. */
function initMembers(services: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const def of Object.values(services)) {
    const dep = asObject(asObject(def)?.depends_on);
    if (!dep) continue; // list form carries no condition (= service_started)
    for (const [target, cond] of Object.entries(dep)) {
      if (asObject(cond)?.condition === "service_completed_successfully") out.add(target);
    }
  }
  return out;
}

/** The services of `composeYaml` that Tugra stamps with `restart: unless-stopped`, in file order. [] when the file is
 *  empty / unparseable / has no services (never throws). Pass the RENDERED stack (`docker compose config`) for a
 *  git-compose app: it has `extends` / anchors / interpolation already resolved. */
export function composeRestartServices(composeYaml: string | null | undefined): string[] {
  if (!composeYaml) return [];
  let doc: unknown;
  try {
    doc = parse(composeYaml, { merge: true });
  } catch {
    return [];
  }
  const services = asObject(asObject(doc)?.services);
  if (!services) return [];
  const init = initMembers(services);
  const out: string[] = [];
  for (const [name, raw] of Object.entries(services)) {
    const def = asObject(raw);
    if (!def || !SERVICE_KEY.test(name)) continue;
    if (init.has(name)) continue;
    if (def.provider != null) continue; // a compose provider service is not a container
    const mode = asObject(def.deploy)?.mode;
    if (mode === "replicated-job" || mode === "global-job") continue;
    if (setsRestart(name, services, new Set())) continue;
    out.push(name);
  }
  return out;
}
