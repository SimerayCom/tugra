/**
 * Pure builders for deploying an app as a Docker Swarm SERVICE (Phase3), run on a swarm MANAGER node.
 * The agent is a generic `sh -c` executor, so nothing on the agent changes — these are just new hub-side
 * command strings, alongside the classic single-container builders in deploy-script.ts.
 *
 * Key differences from the classic `docker run` path (all handled here):
 *  - `docker service create/update` is ASYNC — we `--detach` and then poll `docker service ps` /
 *    `docker service inspect .UpdateStatus` in a bounded loop, echoing a `TUGRA_ROLLOUT:` marker and
 *    exiting 0 (converged) / 3 (auto-rolled-back, previous version kept) / 1 (failed) — the SAME
 *    exit-code contract runDeploy already interprets for the classic rolling/recreate paths.
 *  - No `--env-file` on `docker service create`. Env values are written to a 0600 file, sourced into the
 *    shell, and passed as `--env <KEY>` (NAME only) so values never appear in argv (`ps`), matching the
 *    "secrets never on the process list" house rule. (They do land in the swarm Raft store on the manager
 *    — an accepted Docker-Swarm trade-off, same as `--with-registry-auth`.)
 *  - Swarm resolves+pins every task to a digest; we capture it via `service inspect` for byte-exact rollback.
 */
import { RegistryAuth, containerName, registryLoginPrelude, registryLogoutSteps, envFileB64, envFilePath, ENV_DIR } from "./deploy-script";

/** Single-quote a value for safe shell interpolation. */
function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** The swarm service name for an app — same convention as the classic container name. */
export function serviceName(app: { id: string }): string {
  return containerName(app);
}

/** The attachable overlay network every swarm service (and the swarm-mode Traefik, PhaseB) joins so tasks
 *  can reach each other across nodes. Created on a manager, idempotent. */
export const SWARM_OVERLAY = "tugra-swarm";

export function buildOverlayEnsureScript(name = SWARM_OVERLAY): string {
  return `docker network create -d overlay --attachable ${shq(name)} 2>/dev/null || true`;
}

// Container health-check cadence (mirrors the classic path's runContainerArgs defaults).
const HEALTH = { intervalSec: 10, timeoutSec: 5, retries: 3, startPeriodSec: 30 };

/** `--update-monitor` MUST cover the health check's start period + all retries, or Swarm declares the
 *  rollout "completed" before its own health check has even run — a false-positive convergence. */
export function updateMonitorSec(healthCmd?: string | null): number {
  return healthCmd ? HEALTH.startPeriodSec + HEALTH.retries * HEALTH.intervalSec : 15;
}

export interface ServiceDeployOpts {
  serviceName: string;
  ref: string; // registry-hosted image ref (IMAGE upstream, or the pushed GIT tag) — reachable by all nodes
  replicas: number;
  network: string; // the attachable overlay network the service joins
  env: Record<string, string>;
  registryAuth?: RegistryAuth | null; // login before create/update + --with-registry-auth distributes it
  memoryMb?: number | null;
  cpus?: number | null;
  healthCmd?: string | null;
  labels?: string[]; // service-level labels (Traefik swarm-provider reads these) — PhaseB; [] in PhaseA
  publish?: string[]; // routing-mesh published ports, e.g. "8080:80" (reachable on any node) — domain-less apps
  pollSec: number; // total rollout poll budget (effective timeout, sized by replica count)
}

/** Health-check flags shared by create and update. */
function healthFlags(healthCmd?: string | null): string[] {
  if (!healthCmd) return [];
  return [
    `--health-cmd ${shq(healthCmd)}`,
    `--health-interval ${HEALTH.intervalSec}s`,
    `--health-timeout ${HEALTH.timeoutSec}s`,
    `--health-retries ${HEALTH.retries}`,
    `--health-start-period ${HEALTH.startPeriodSec}s`,
  ];
}

/**
 * Env handling for a swarm service. The app's env is written to a 0600 file (KEY=VALUE data) and loaded
 * SAFELY — the file is NEVER `.`/`source`d (that would execute a value like `X=$(rm -rf /)` as a command =
 * RCE, and break any value with a space). `read` treats the value as literal text; variable expansion does
 * not re-evaluate `$()` inside an already-read value, so arbitrary values stay inert.
 *
 *  - create: export the vars, then `--env KEY` (NAME only) so values load from the environment, never argv.
 *  - update: `docker service update` has no name-only env form, so build `--env-add "$k=$v"` args via
 *    `set --` (a proper arg array that survives values with spaces). Those values touch argv briefly, but
 *    they already live in the swarm Raft store — no additional secret exposure. Re-applying env on update
 *    is what makes an env CHANGE actually take effect (update only mutates the fields you name).
 */
function envHelpers(o: ServiceDeployOpts): {
  writeSteps: string[];
  createLoad: string[];
  createFlags: string[];
  updateBuild: string[];
} {
  const env = o.env && typeof o.env === "object" ? o.env : {};
  const keys = Object.keys(env);
  if (keys.length === 0) return { writeSteps: [], createLoad: [], createFlags: [], updateBuild: [`set --`] };
  const path = envFilePath({ id: o.serviceName });
  // `|| [ -n "$TUGRA_K" ]` also processes a final line with no trailing newline; IFS='=' splits on the FIRST
  // '=' only (values may contain further '=').
  const readHead = `while IFS='=' read -r TUGRA_K TUGRA_V || [ -n "$TUGRA_K" ]; do [ -n "$TUGRA_K" ] &&`;
  return {
    writeSteps: [
      `mkdir -p ${ENV_DIR}`,
      `printf %s ${shq(envFileB64(env))} | base64 -d > ${path}`,
      `chmod 600 ${path}`,
    ],
    createLoad: [`${readHead} export "$TUGRA_K=$TUGRA_V"; done < ${path}`],
    createFlags: keys.map((k) => `--env ${shq(k)}`),
    updateBuild: [`set --`, `${readHead} set -- "$@" --env-add "$TUGRA_K=$TUGRA_V"; done < ${path}`],
  };
}

/** The in-script bounded rollout poll: converge via `service ps`, detect auto-rollback / stuck via
 *  `.UpdateStatus`. Echoes a TUGRA_ROLLOUT marker and exits 0 (converged) / 3 (auto-rolled-back) / 1
 *  (failed). `failCleanup` (a shell snippet) runs just before the failure exit — the deploy path passes a
 *  create-only `docker service rm` there so a never-converged first-create leaves no orphan service. */
function pollFragment(svc: string, replicas: number, pollSec: number, failCleanup = ""): string {
  const intervalSec = 3;
  const maxIter = Math.max(2, Math.ceil(pollSec / intervalSec));
  const q = shq(svc);
  const psState = `docker service ps ${q} --filter desired-state=running --format '{{.CurrentState}}' 2>/dev/null`;
  const digestEcho = `TUGRA_D=$(docker service inspect ${q} --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true); if [ -n "$TUGRA_D" ]; then echo "TUGRA_SVC_DIGEST=$TUGRA_D"; fi`;
  return [
    `TUGRA_OK=0; TUGRA_I=0`,
    `while [ "$TUGRA_I" -lt ${maxIter} ]; do`,
    `  if [ "$TUGRA_MODE" = update ]; then`,
    // UPDATE (redeploy/restart): Swarm's own UpdateStatus is the ONLY reliable convergence signal — with
    // --update-parallelism 1 the not-yet-updated slots keep their OLD task in state Running, so a plain
    // "count Running tasks" would hit the replica target (all-old) and falsely converge within seconds.
    `    TUGRA_ST=$(docker service inspect ${q} --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null || true)`,
    `    if [ "$TUGRA_ST" = "completed" ]; then ${digestEcho}; echo "TUGRA_ROLLOUT: converged"; exit 0; fi`,
    `    if [ "$TUGRA_ST" = "rollback_completed" ]; then echo "TUGRA_ROLLOUT: rolled_back"; exit 3; fi`,
    `    if [ "$TUGRA_ST" = "paused" ] || [ "$TUGRA_ST" = "rollback_paused" ]; then echo "TUGRA_ROLLOUT: paused"; break; fi`,
    `  else`,
    // FIRST CREATE: no UpdateStatus, and every task is new — counting Running tasks is accurate here.
    `    TUGRA_RUN=$(${psState} | grep -c '^Running' || true)`,
    `    TUGRA_FAIL=$(${psState} | grep -cE '^(Failed|Rejected)' || true)`,
    `    if [ "\${TUGRA_RUN:-0}" -ge ${replicas} ]; then TUGRA_OK=$((TUGRA_OK+1)); else TUGRA_OK=0; fi`,
    `    if [ "$TUGRA_OK" -ge 2 ]; then ${digestEcho}; echo "TUGRA_ROLLOUT: converged"; exit 0; fi`,
    `    if [ "\${TUGRA_FAIL:-0}" -ge ${replicas} ]; then break; fi`,
    `  fi`,
    `  TUGRA_I=$((TUGRA_I+1)); sleep ${intervalSec}`,
    `done`,
    `${failCleanup}echo "TUGRA_ROLLOUT: failed"; exit 1`,
  ].join("\n");
}

/** Common flag list for both create and update (image is passed positionally on create). */
function commonServiceFlags(o: ServiceDeployOpts): string[] {
  const flags: string[] = [`--with-registry-auth`, `--update-failure-action rollback`, `--update-monitor ${updateMonitorSec(o.healthCmd)}s`];
  if (o.memoryMb) flags.push(`--limit-memory ${o.memoryMb}m`);
  if (o.cpus) flags.push(`--limit-cpu ${o.cpus}`);
  return flags;
}

/**
 * Idempotent, existence-driven create-vs-update — decided by `docker service inspect`, NOT by Tugra's
 * local Deployment history, so a prior failed attempt that left a real service object behind can't wedge
 * the next deploy into a "service already exists" error.
 */
export function buildServiceDeployScript(o: ServiceDeployOpts): string {
  const q = shq(o.serviceName);
  const env = envHelpers(o);
  const health = healthFlags(o.healthCmd);
  const labels = o.labels ?? [];
  const publish = o.publish ?? [];

  const createFlags = [
    `--name ${q}`,
    `--replicas ${o.replicas}`,
    `--network ${shq(o.network)}`,
    ...commonServiceFlags(o),
    // Bound crash-loops so a broken image reaches a terminal Failed state instead of retrying forever.
    `--restart-condition any`,
    `--restart-max-attempts 3`,
    `--restart-delay 5s`,
    `--restart-window 30s`,
    `--update-parallelism 1`,
    `--update-order start-first`,
    ...health,
    ...labels.map((l) => `--label ${shq(l)}`),
    ...publish.map((p) => `--publish ${shq(p)}`),
    ...env.createFlags,
    shq(o.ref),
  ].join(" ");

  // Update RE-APPLIES the full desired state (`docker service update` only mutates the fields you name), so
  // a domain/label/env/health/publish CHANGE on a redeploy actually takes effect — not just the image. Uses
  // the -add variants + env args from `set --` (built by env.updateBuild). monitor+failure-action every time
  // (Swarm does NOT remember prior invocations' flags). Note: removing a domain/env-key entirely leaves the
  // stale label/var behind (v1) — a fresh recreate clears it.
  const updateFlags = [
    `--image ${shq(o.ref)}`,
    ...commonServiceFlags(o),
    `--replicas ${o.replicas}`,
    ...health,
    ...labels.map((l) => `--label-add ${shq(l)}`),
    ...publish.map((p) => `--publish-add ${shq(p)}`),
    `"$@"`, // --env-add args built by env.updateBuild
    q,
  ].join(" ");

  return [
    "set +e",
    ...registryLoginPrelude(o.registryAuth),
    ...env.writeSteps,
    `if docker service inspect ${q} >/dev/null 2>&1; then`,
    `  TUGRA_MODE=update`,
    ...env.updateBuild.map((s) => `  ${s}`),
    `  docker service update --detach ${updateFlags}`,
    `  TUGRA_RC=$?`,
    `else`,
    `  TUGRA_MODE=create`,
    ...env.createLoad.map((s) => `  ${s}`),
    `  docker service create --detach ${createFlags}`,
    `  TUGRA_RC=$?`,
    `fi`,
    ...registryLogoutSteps(o.registryAuth),
    // A non-zero create/update (bad ref, auth failure at schedule time, or an "already exists" caused by a
    // transient inspect glitch that mis-routed us to create) → report and stop WITHOUT removing anything:
    // create validates before creating, so a genuine failure leaves no service object, while an "already
    // exists" means a LIVE service is running that must not be deleted. The poll-fail cleanup below handles
    // the only case that needs teardown: a create that succeeded but never converged.
    `if [ "$TUGRA_RC" -ne 0 ]; then echo "TUGRA_ROLLOUT: create_failed"; exit 1; fi`,
    // Poll to convergence. On first-create failure, tear down the never-converged service so Docker and DB
    // stay in lockstep (and the existence-driven branch above stays correct on retry); on update, leave the
    // old tasks running.
    pollFragment(o.serviceName, o.replicas, o.pollSec, `[ "$TUGRA_MODE" = create ] && docker service rm ${q} >/dev/null 2>&1 || true; `),
  ].join("\n");
}

/** Scale a service (stop = 0, start = the app's stored replica count). Fire-and-forget; status reconciles. */
export function buildServiceScaleScript(name: string, replicas: number): string {
  return `docker service scale --detach ${shq(name)}=${replicas}`;
}

/** Force a rolling recreation of all tasks (restart) — async, so callers poll for convergence. */
export function buildServiceRestartScript(name: string, replicas: number, pollSec: number): string {
  // A --force update is an UPDATE rollout → the poll must use the UpdateStatus branch (TUGRA_MODE=update).
  return ["set +e", "TUGRA_MODE=update", `docker service update --detach --force ${shq(name)}`, pollFragment(name, replicas, pollSec)].join("\n");
}

/** Remove the service cluster-wide (Swarm tears down every task immediately). */
export function buildServiceRemoveScript(name: string): string {
  return `docker service rm ${shq(name)} 2>/dev/null || true`;
}

/** Task status across all nodes — one JSON object per task (for the status/containers view). */
export function buildServicePsScript(name: string): string {
  return `docker service ps ${shq(name)} --format '{{json .}}'`;
}

/** One-shot aggregated logs across replicas (live-follow uses log_start with service=true). --timestamps
 *  + optional --since match the classic download path (since must be pre-normalized to a safe value). */
export function buildServiceLogsScript(name: string, tail = 200, since?: string): string {
  const s = since ? ` --since ${shq(since)}` : "";
  return `docker service logs --timestamps --tail ${Math.max(0, Math.floor(tail))}${s} ${shq(name)}`;
}

/** A RUNNING task container of this service ON THE HOST it's run on (for terminal exec). Matching by the
 *  service-name label + status=running is robust — no fragile short/full task-id juggling; any running
 *  replica on that node is a valid shell target. Returns one name per line (take the first). */
export function buildServiceTaskContainerScript(name: string): string {
  return `docker ps --filter label=com.docker.swarm.service.name=${shq(name)} --filter status=running --format '{{.Names}}'`;
}

/** Parse the swarm-resolved image digest (ref@sha256:…) echoed by the deploy script's convergence path. */
export function parseServiceImageDigest(output: string): string | null {
  const m = output.match(/TUGRA_SVC_DIGEST=(\S+)/);
  return m ? m[1] : null;
}

/** Parse `docker service ps --format '{{json .}}'` (one JSON task per line) into a {name,state} list for
 *  the app "containers" view — each task shows its slot name, node, and current state. */
export function parseServiceTasks(output: string): { name: string; state: string }[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const j = JSON.parse(line);
        const name = String(j.Name ?? "");
        const node = j.Node ? ` on ${String(j.Node)}` : "";
        return { name: `${name}${node}`, state: String(j.CurrentState ?? j.DesiredState ?? "") };
      } catch {
        return null;
      }
    })
    .filter((t): t is { name: string; state: string } => t !== null);
}

/** One swarm task as shown in the live replica panel: its slot name, the node it landed on, and its
 *  desired vs current state (+ any scheduling error). */
export interface SwarmTask {
  slot: string;
  node: string;
  desiredState: string;
  currentState: string;
  error: string;
}

/** Parse `docker service ps --format '{{json .}}'` (one JSON task per line) into structured {@link SwarmTask}s
 *  for the live replica panel. Unlike {@link parseServiceTasks} (which flattens name+node+state for the
 *  terminal picker) this keeps the fields separate so the UI can render a slot/node/state table and count
 *  running replicas. Malformed lines are skipped. */
export function parseSwarmTasks(output: string): SwarmTask[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line): SwarmTask | null => {
      try {
        const j = JSON.parse(line);
        return {
          slot: String(j.Name ?? ""),
          node: String(j.Node ?? ""),
          desiredState: String(j.DesiredState ?? ""),
          currentState: String(j.CurrentState ?? ""),
          error: String(j.Error ?? ""),
        };
      } catch {
        return null;
      }
    })
    .filter((t): t is SwarmTask => t !== null);
}
