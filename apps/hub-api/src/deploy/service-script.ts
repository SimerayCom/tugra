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

/** `--opt encrypted` turns on IPsec ESP encryption for inter-node VXLAN traffic. Swarm's own control-plane
 *  gossip is already TLS-encrypted; this additionally protects the DATA PLANE — the actual traffic between
 *  service tasks on different nodes. No competitor Docker-Swarm PaaS turns this on by default.
 *
 *  MIGRATION NOTE: this only affects a network created FRESH. `docker network create` with the SAME name but
 *  different options on an EXISTING network returns non-zero ("already exists"), which the trailing `|| true`
 *  swallows — so a cluster whose overlay was created before this change keeps running UNENCRYPTED until an
 *  operator manually removes+recreates it (requires no services attached, i.e. stop every swarm app on that
 *  cluster → `docker network rm tugra-swarm` on the manager → redeploy). Doc-only migration for now (see
 *  CHANGELOG); a future slice could warn when `docker network inspect tugra-swarm --format
 *  '{{.Options.encrypted}}'` comes back empty. */
export function buildOverlayEnsureScript(name = SWARM_OVERLAY): string {
  return `docker network create -d overlay --opt encrypted --attachable ${shq(name)} 2>/dev/null || true`;
}

// ── FLEET-F: swarm app env via Docker secret (encrypted-at-rest in Raft) instead of plaintext in the spec ──
// Swarm has no k8s-style envFrom — a secret is always a FILE under /run/secrets. To turn it into process env
// we override the entrypoint with a tiny loader that reads the file, exports each KEY=VALUE, then execs the
// image's OWN command. This only works on images that HAVE a shell; the caller (dispatchService) detects that
// and only sets envSecret when a shell exists — a shell-less image (distroless/scratch) falls back to the
// classic plaintext --env path (envHelpers), so it is never silently broken.
export const APP_ENV_CONFIGHASH_LABEL = "tugra.app.envhash";
const APP_ENV_MOUNT = "app_env";
// Deliberately ZERO single quotes (keeps the update-path nested shq() a single clean layer). Guarded: if the
// secret isn't mounted (no env, or a legacy service on its first migrating update) it just execs the app.
const APP_ENV_WRAPPER = `if [ -f /run/secrets/${APP_ENV_MOUNT} ]; then while IFS="=" read -r k v || [ -n "$k" ]; do [ -n "$k" ] && export "$k=$v"; done < /run/secrets/${APP_ENV_MOUNT}; fi; exec "$@"`;

export interface AppEnvSecret {
  name: string; // tugra-appenv-<serviceName>-<confighash>, minted by the caller (hub-side sha256)
  confighash: string; // order-independent (sorted-by-key) short hash of the env
  credsB64: string; // envFileB64(env) — the KEY=VALUE body used to mint the secret when absent
}

/** Prefix for every hash-named env secret of an app (so every version can be pruned on delete). */
export function appEnvSecretPrefix(serviceNameValue: string): string {
  return `tugra-appenv-${serviceNameValue}`;
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
  /** Soft placement hints (`docker service --reserve-memory`/`--reserve-cpu`): Swarm's scheduler avoids
   *  placing this service's tasks on a node without this much capacity free. Unlike memoryMb/cpus (hard
   *  cgroup ceilings enforced at runtime), a reservation is advisory — it only affects WHERE a task lands,
   *  never throttles/OOM-kills it. Swarm-only: the classic `docker run` path has no reservation flag, so
   *  these are never read outside this file. */
  reserveMemoryMb?: number | null;
  reserveCpus?: number | null;
  healthCmd?: string | null;
  labels?: string[]; // service-level labels (Traefik swarm-provider reads these) — PhaseB; [] in PhaseA
  publish?: string[]; // routing-mesh published ports, e.g. "8080:80" (reachable on any node) — domain-less apps
  constraints?: string[]; // already-rendered `--constraint` expressions (e.g. "node.hostname==web-1") — FLEET-D
  placementPrefs?: string[]; // already-rendered `--placement-pref` expressions (e.g. "spread=node.labels.zone") — FLEET-D
  mounts?: { source: string; target: string }[]; // named-volume mounts for a node-pinned stateful app — FLEET-E
  // FLEET-F: when set, env rides this Docker secret (not plaintext --env) and the entrypoint is wrapped to load
  // it. Only set by the caller when the image HAS a shell; null → the classic plaintext `env` path below is used.
  envSecret?: AppEnvSecret | null;
  imageEntrypoint?: string[]; // the image's OWN .Config.Entrypoint (re-supplied to the wrapper) — only with envSecret
  imageCmd?: string[]; // the image's OWN .Config.Cmd (re-supplied to the wrapper) — only with envSecret
  // FLEET-F: set when the app HAS env but the image is shell-less (plaintext fallback). If such a service was
  // previously env-secret-WRAPPED, `docker service update` can't reset its entrypoint — so recreate instead.
  // Only meaningful when envSecret is null; keeps no-env/classic apps' scripts byte-identical to before.
  envFallbackNoShell?: boolean;
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
  if (o.reserveMemoryMb) flags.push(`--reserve-memory ${o.reserveMemoryMb}m`);
  if (o.reserveCpus) flags.push(`--reserve-cpu ${o.reserveCpus}`);
  return flags;
}

/** Full remove-then-add of a service's placement constraints/preferences on UPDATE (FLEET-D). Docker has no
 *  "replace the whole list" flag — only --constraint-add/-rm — and a STALE constraint is a correctness bug
 *  (pinning to A then adding B leaves A AND B active, ANDing to permanently-unschedulable). So we inspect the
 *  LIVE service, remove EVERY current constraint/pref, then add the complete desired set — unconditionally,
 *  even when the desired set is empty (a user who cleared placement must still get the old ones stripped).
 *  Appends onto the SAME `$@` positional list env.updateBuild already started (no second bare `set --`, which
 *  would wipe the accumulated --env-add args). IFS is set to a literal newline so a plain `for x in $VAR`
 *  splits the inspect output on lines only (constraint/pref values are whitespace-free) with no subshell —
 *  a `| while read` pipeline WOULD subshell and lose the accumulated `$@`, the hazard this file already notes. */
function placementUpdateBuild(svc: string, constraints: string[], placementPrefs: string[]): string[] {
  const q = shq(svc);
  return [
    `TUGRA_CUR_C=$(docker service inspect ${q} --format '{{range .Spec.TaskTemplate.Placement.Constraints}}{{.}}{{println}}{{end}}' 2>/dev/null || true)`,
    `TUGRA_CUR_P=$(docker service inspect ${q} --format '{{range .Spec.TaskTemplate.Placement.Preferences}}spread={{.Spread.SpreadDescriptor}}{{println}}{{end}}' 2>/dev/null || true)`,
    `TUGRA_OLDIFS=$IFS`,
    `IFS='\n'`,
    `for TUGRA_X in $TUGRA_CUR_C; do set -- "$@" --constraint-rm "$TUGRA_X"; done`,
    `for TUGRA_X in $TUGRA_CUR_P; do set -- "$@" --placement-pref-rm "$TUGRA_X"; done`,
    `IFS=$TUGRA_OLDIFS`,
    ...constraints.map((c) => `set -- "$@" --constraint-add ${shq(c)}`),
    ...placementPrefs.map((p) => `set -- "$@" --placement-pref-add ${shq(p)}`),
  ];
}

/**
 * Idempotent, existence-driven create-vs-update — decided by `docker service inspect`, NOT by Tugra's
 * local Deployment history, so a prior failed attempt that left a real service object behind can't wedge
 * the next deploy into a "service already exists" error.
 */
export function buildServiceDeployScript(o: ServiceDeployOpts): string {
  const q = shq(o.serviceName);
  const health = healthFlags(o.healthCmd);
  const labels = o.labels ?? [];
  const publish = o.publish ?? [];
  const constraints = o.constraints ?? [];
  const placementPrefs = o.placementPrefs ?? [];
  const mounts = o.mounts ?? [];
  const es = o.envSecret ?? null;
  const ep = o.imageEntrypoint ?? [];
  const cmd = o.imageCmd ?? [];
  const envPrefix = appEnvSecretPrefix(o.serviceName);
  // Classic plaintext env path — non-swarm apps, no-env apps, and (fallback) shell-less swarm images. When an
  // env SECRET is in play (es) it FULLY replaces this (no --env in the spec at all).
  const env = es ? null : envHelpers(o);

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
    ...constraints.map((c) => `--constraint ${shq(c)}`),
    ...placementPrefs.map((p) => `--placement-pref ${shq(p)}`),
    ...labels.map((l) => `--label ${shq(l)}`),
    ...publish.map((p) => `--publish ${shq(p)}`),
    ...mounts.map((m) => `--mount ${shq(`type=volume,source=${m.source},destination=${m.target}`)}`),
    ...(es
      ? [`--label ${APP_ENV_CONFIGHASH_LABEL}=${shq(es.confighash)}`, `--secret source=${shq(es.name)},target=${APP_ENV_MOUNT}`, `--entrypoint sh`]
      : env!.createFlags),
    shq(o.ref),
    // Secret path only: after the ref, `sh -c <wrapper> $0 $1...` — "app" is the $0 process-name placeholder,
    // the image's real Entrypoint+Cmd are $1.. which the wrapper execs. (--entrypoint is just ["sh"] here, so it
    // adds no $0 of its own — unlike the UPDATE path whose --entrypoint string carries its own trailing "_".)
    ...(es ? [`-c ${shq(APP_ENV_WRAPPER)}`, `app`, ...ep.map(shq), ...cmd.map(shq)] : []),
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
    ...mounts.map((m) => `--mount-add ${shq(`type=volume,source=${m.source},destination=${m.target}`)}`),
    `"$@"`, // accumulated below: plaintext --env-add (classic), OR --env-rm scrub + --secret-* (secret), + placement
    ...(es
      ? [`--entrypoint ${shq(`sh -c ${shq(APP_ENV_WRAPPER)} _`)}`, `--args ${shq([...ep, ...cmd].map(shq).join(" "))}`]
      : []),
    q,
  ].join(" ");

  // Secret-path update accumulator: scrub any plaintext env still on the spec (legacy/migration), then rotate
  // the secret ONLY when the confighash label changed (runtime check — race-safe, mirrors swarm-proxy's reconcile).
  const secretUpdateBuild = es
    ? [
        `set --`,
        `TUGRA_ENVLIST=$(mktemp)`,
        `docker service inspect ${q} --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{.}}{{"\\n"}}{{end}}' > "$TUGRA_ENVLIST" 2>/dev/null || true`,
        `while IFS='=' read -r TUGRA_EK TUGRA_EV || [ -n "$TUGRA_EK" ]; do [ -n "$TUGRA_EK" ] && set -- "$@" --env-rm "$TUGRA_EK"; done < "$TUGRA_ENVLIST"`,
        `rm -f "$TUGRA_ENVLIST"`,
        `TUGRA_CUR=$(docker service inspect ${q} --format '{{index .Spec.Labels "${APP_ENV_CONFIGHASH_LABEL}"}}' 2>/dev/null || echo "")`,
        // Remember the superseded secret's name so we can DELETE the object after the update (--secret-rm only
        // detaches the reference; the object lingers in the Raft store otherwise — one orphan per env change).
        `TUGRA_OLD_SECRET=""`,
        `if [ "$TUGRA_CUR" != ${shq(es.confighash)} ]; then`,
        `  [ -n "$TUGRA_CUR" ] && TUGRA_OLD_SECRET=${shq(envPrefix)}"-$TUGRA_CUR" && set -- "$@" --secret-rm "$TUGRA_OLD_SECRET"`,
        `  set -- "$@" --secret-add source=${shq(es.name)},target=${APP_ENV_MOUNT} --label-add ${APP_ENV_CONFIGHASH_LABEL}=${shq(es.confighash)}`,
        `fi`,
      ]
    : env!.updateBuild;

  // Reusable create branch (also used by the es-null recreate-if-wrapped transition below).
  const createLines = (ind: string): string[] => [
    `${ind}TUGRA_MODE=create`,
    ...(es ? [] : env!.createLoad).map((s) => `${ind}${s}`),
    `${ind}docker service create --detach ${createFlags}`,
    `${ind}TUGRA_RC=$?`,
  ];

  const updateBranch = es
    ? [
        `  TUGRA_MODE=update`,
        ...secretUpdateBuild.map((s) => `  ${s}`),
        ...placementUpdateBuild(o.serviceName, constraints, placementPrefs).map((s) => `  ${s}`),
        `  docker service update --detach ${updateFlags}`,
        `  TUGRA_RC=$?`,
        // Delete the just-detached OLD secret OBJECT (see TUGRA_OLD_SECRET) — --secret-rm only drops the reference.
        `  [ "$TUGRA_RC" -eq 0 ] && [ -n "$TUGRA_OLD_SECRET" ] && docker secret rm "$TUGRA_OLD_SECRET" >/dev/null 2>&1 || true`,
      ]
    : o.envFallbackNoShell
      ? [
          // Plaintext fallback (env present, shell-less image). A service still wrapped by a PREVIOUS env-secret
          // deploy can't have its entrypoint reset by `docker service update` — RECREATE so the new image runs
          // its OWN command instead of the now-dead `sh -c` wrapper (which the shell-less image can't exec).
          `  TUGRA_WAS_WRAPPED=$(docker service inspect ${q} --format '{{index .Spec.Labels "${APP_ENV_CONFIGHASH_LABEL}"}}' 2>/dev/null || echo "")`,
          `  if [ -n "$TUGRA_WAS_WRAPPED" ]; then`,
          `    docker service rm ${q} >/dev/null 2>&1 || true`,
          ...createLines("    "),
          `  else`,
          `    TUGRA_MODE=update`,
          ...env!.updateBuild.map((s) => `    ${s}`),
          ...placementUpdateBuild(o.serviceName, constraints, placementPrefs).map((s) => `    ${s}`),
          `    docker service update --detach ${updateFlags}`,
          `    TUGRA_RC=$?`,
          `  fi`,
        ]
      : [
          `  TUGRA_MODE=update`,
          ...env!.updateBuild.map((s) => `  ${s}`),
          ...placementUpdateBuild(o.serviceName, constraints, placementPrefs).map((s) => `  ${s}`),
          `  docker service update --detach ${updateFlags}`,
          `  TUGRA_RC=$?`,
        ];

  return [
    "set +e",
    ...registryLoginPrelude(o.registryAuth),
    // Secret path: mint the immutable hash-named secret if absent (same idempotent pattern as swarm-proxy's DNS
    // creds). Classic path: write the 0600 env file. Only one runs.
    ...(es
      ? [`docker secret inspect ${shq(es.name)} >/dev/null 2>&1 || printf %s ${shq(es.credsB64)} | base64 -d | docker secret create ${shq(es.name)} -`]
      : env!.writeSteps),
    `if docker service inspect ${q} >/dev/null 2>&1; then`,
    ...updateBranch,
    `else`,
    ...createLines("  "),
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

/** Scale a service (stop = 0, start = the app's stored replica count) AND poll to convergence — exactly like
 *  restart()/deploy() do (SAME pollFragment machinery), so a stop/start actually confirms the tasks reached
 *  the target count instead of reporting success the instant Swarm ACCEPTED the request. TUGRA_MODE stays
 *  "create" (never "update"): a pure replica-count change does NOT set Docker's Spec.UpdateStatus (that only
 *  fires when the TASK SPEC changes — image/env/labels/health), so convergence is judged the same way FIRST
 *  CREATE is: counting Running tasks against the target. For replicas=0 (stop) this converges as soon as 0
 *  Running tasks remain. */
export function buildServiceScaleScript(name: string, replicas: number, pollSec: number): string {
  return ["set +e", "TUGRA_MODE=create", `docker service scale --detach ${shq(name)}=${replicas}`, pollFragment(name, replicas, pollSec)].join("\n");
}

/** Force a rolling recreation of all tasks (restart) — async, so callers poll for convergence. */
export function buildServiceRestartScript(name: string, replicas: number, pollSec: number): string {
  // A --force update is an UPDATE rollout → the poll must use the UpdateStatus branch (TUGRA_MODE=update).
  return ["set +e", "TUGRA_MODE=update", `docker service update --detach --force ${shq(name)}`, pollFragment(name, replicas, pollSec)].join("\n");
}

/** Remove the service cluster-wide (Swarm tears down every task immediately) AND prune every version of its
 *  env secret (FLEET-F) — mirrors the swarm-proxy teardown's unconditional secret prune. */
export function buildServiceRemoveScript(name: string): string {
  const prefix = appEnvSecretPrefix(name);
  return `docker service rm ${shq(name)} 2>/dev/null || true; for s in $(docker secret ls --filter name=${shq(prefix)} --format '{{.Name}}' 2>/dev/null); do docker secret rm "$s" >/dev/null 2>&1 || true; done`;
}

/** Pull an image on the manager and read its OWN Entrypoint/Cmd + whether it has a shell (FLEET-F). Needed
 *  because overriding --entrypoint for the env-secret wrapper DISCARDS the image's baked-in CMD, so the wrapper
 *  must re-supply the real command; and a shell-less image can't run the wrapper at all (caller falls back). */
export function buildInspectEntrypointScript(ref: string, auth?: RegistryAuth | null): string {
  const q = shq(ref);
  return [
    "set -e",
    ...registryLoginPrelude(auth),
    `docker pull -q ${q}`,
    ...registryLogoutSteps(auth),
    `echo "TUGRA_ENTRYPOINT=$(docker inspect ${q} --format '{{json .Config.Entrypoint}}')"`,
    `echo "TUGRA_CMD=$(docker inspect ${q} --format '{{json .Config.Cmd}}')"`,
    // Definitive shell test (the `if` swallows the non-zero so `set -e` doesn't abort). No shell → the caller
    // keeps env as plaintext instead of a wrapper that would never exec.
    `if docker run --rm --entrypoint /bin/sh ${q} -c ':' >/dev/null 2>&1; then echo "TUGRA_HAS_SHELL=yes"; else echo "TUGRA_HAS_SHELL=no"; fi`,
  ].join("\n");
}

/** Parse buildInspectEntrypointScript's output (structured, in TS — never in shell, per this file's convention). */
export function parseImageEntrypointCmd(output: string): { entrypoint: string[]; cmd: string[]; hasShell: boolean } {
  const grab = (marker: string): string[] => {
    for (const line of output.split("\n")) {
      const t = line.trim();
      if (t.startsWith(`${marker}=`)) {
        try {
          const v = JSON.parse(t.slice(marker.length + 1));
          return Array.isArray(v) ? v.map(String) : [];
        } catch {
          return [];
        }
      }
    }
    return [];
  };
  const hasShell = output.split("\n").some((l) => l.trim() === "TUGRA_HAS_SHELL=yes");
  return { entrypoint: grab("TUGRA_ENTRYPOINT"), cmd: grab("TUGRA_CMD"), hasShell };
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
