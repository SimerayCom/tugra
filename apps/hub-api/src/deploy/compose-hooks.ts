/**
 * Pre/post-deploy hooks for COMPOSE apps (pure builders, no Nest I/O).
 *
 * The hub decides the hook plan (which service, pull vs build) from the compose YAML it already holds (the stored
 * file for a pasted app, the validated RENDERED stack for a git-compose app); the steps are spliced into the ONE
 * durable compose `up` command, so a hub restart / agent adoption recovers the hooks together with the deploy.
 *
 *  - PRE  (after the registry login, before `up`): pull|build the hook service's image, then a one-shot
 *    `compose run --rm` of that service. A non-zero exit aborts the deploy BEFORE `up` (the old stack keeps serving).
 *    `run` deliberately omits `--no-deps`: a migration hook must reach its database, including on a first deploy.
 *    `run` keeps the service's labels and networks, so the one-off container would register as a Traefik backend of
 *    the live router (a container with no listener): `-l traefik.enable=false` overrides the label for that container.
 *  - POST (after `up`, the registry logout and `ps`): wait for the service to be running (and healthy when it has a
 *    healthcheck), then `compose exec`. Best-effort: it always exits 0, so a failure never marks the deploy FAILED.
 *
 * Every compose invocation here carries the SAME prefix / files / env-file as `up`, otherwise literal or multiline
 * variables would not interpolate. Every shell value goes through shq(); the one-off container name is hub-fixed.
 */

import { BadRequestException } from "@nestjs/common";
import { parse } from "yaml";
import { shq, type AppSpec } from "./deploy-script";

export interface ComposeHookPlan {
  service: string;
  pre: string | null;
  post: string | null;
  prepare: "pull" | "build";
}

function servicesOf(composeYaml: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = parse(composeYaml, { merge: true });
  } catch {
    return {};
  }
  const services = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as { services?: unknown }).services : null;
  return services && typeof services === "object" && !Array.isArray(services) ? (services as Record<string, unknown>) : {};
}

/** null when neither command is set (after trim). Throws BadRequestException when the service is missing or is not a
 *  key of `services` in `composeYaml`. prepare = "build" iff the service has a `build:` key, else "pull". */
export function composeHookPlan(app: AppSpec, composeYaml: string): ComposeHookPlan | null {
  const pre = app.preDeployCommand?.trim() || null;
  const post = app.postDeployCommand?.trim() || null;
  if (!pre && !post) return null;
  const service = app.composeHookService?.trim();
  if (!service) throw new BadRequestException("a service is required for a compose deploy hook");
  const services = servicesOf(composeYaml);
  if (!Object.prototype.hasOwnProperty.call(services, service)) {
    throw new BadRequestException(`deploy hook service "${service}" is not in the compose file (services: ${Object.keys(services).join(", ") || "none"})`);
  }
  const def = services[service];
  const hasBuild = !!def && typeof def === "object" && (def as { build?: unknown }).build != null;
  return { service, pre, post, prepare: hasBuild ? "build" : "pull" };
}

export interface ComposeHookOpts {
  proj: string;
  /** `-f <file> [-f <override>] ` exactly as the `up` line passes it. */
  files: string;
  /** Same string as `up` (`--env-file P ` or ""). */
  envArg: string;
  /** mlPrefix(plan.shell). */
  prefix: string;
  noCache: boolean;
}

/** The hub-fixed one-off container name (no user value ever reaches a Tugra-integrity flag). */
export function composeHookContainerName(app: { id: string }): string {
  return `tugra_${app.id}_hook`;
}

function stem(o: ComposeHookOpts, progress = false): string {
  return `${o.prefix}docker compose ${progress ? "--progress plain " : ""}-p ${o.proj} ${o.files}${o.envArg}`;
}

export function composeHookPreSteps(app: AppSpec, p: ComposeHookPlan, o: ComposeHookOpts): string[] {
  if (!p.pre) return [];
  const svc = shq(p.service);
  const name = composeHookContainerName(app);
  return [
    `echo "TUGRA_PREDEPLOY: running"`,
    p.prepare === "build" ? `${stem(o, true)}build ${o.noCache ? "--no-cache " : ""}${svc}` : `${stem(o, true)}pull --quiet ${svc}`,
    `docker rm -f ${name} >/dev/null 2>&1 || true`,
    `if ${stem(o)}run --rm -T -l traefik.enable=false --name ${name} --entrypoint sh ${svc} -c ${shq(p.pre)}; then echo "TUGRA_PREDEPLOY: ok"; else echo "TUGRA_PREDEPLOY: failed"; exit 1; fi`,
  ];
}

export function composeHookPostSteps(app: AppSpec, p: ComposeHookPlan, o: ComposeHookOpts): string[] {
  void app;
  if (!p.post) return [];
  const svc = shq(p.service);
  const st = stem(o);
  return [
    `echo "TUGRA_POSTDEPLOY: running"`,
    `TUGRA_CID=; TUGRA_I=0`,
    `while [ $TUGRA_I -lt 30 ]; do`,
    `  TUGRA_CID=$(${st}ps -q ${svc} 2>/dev/null | head -n1)`,
    `  if [ -n "$TUGRA_CID" ]; then TUGRA_ST=$(docker inspect -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$TUGRA_CID" 2>/dev/null || true); case "$TUGRA_ST" in "true healthy"|"true ") break;; esac; fi`,
    `  TUGRA_CID=; TUGRA_I=$((TUGRA_I+1)); sleep 2`,
    `done`,
    `if [ -n "$TUGRA_CID" ]; then ${st}exec -T ${svc} sh -c ${shq(p.post)} && echo "TUGRA_POSTDEPLOY: ok" || echo "TUGRA_POSTDEPLOY: failed (ignored)"; else echo "TUGRA_POSTDEPLOY: failed (service not ready, ignored)"; fi`,
  ];
}
