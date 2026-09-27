import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { Application } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { SwarmProxyService } from "./swarm-proxy.service";
import { createHash } from "node:crypto";
import { appVolumeName, buildBuildOnlyScript, constraintExpr, envFileB64, imageRef, spreadPrefExpr, traefikLabels, type AppSpec, type RegistryAuth } from "../deploy/deploy-script";
import {
  SWARM_OVERLAY,
  appEnvSecretPrefix,
  buildInspectEntrypointScript,
  buildOverlayEnsureScript,
  buildServiceDeployScript,
  buildServiceLogsScript,
  buildServicePsScript,
  buildServiceRemoveScript,
  buildServiceRestartScript,
  buildServiceScaleScript,
  buildServiceTaskContainerScript,
  parseImageEntrypointCmd,
  parseServiceImageDigest,
  serviceName,
  updateMonitorSec,
  type AppEnvSecret,
} from "../deploy/service-script";

/** Order-independent short hash of an app's env (sorted-by-key), so a no-op resave that only reorders keys does
 *  NOT rotate the secret. Mirrors swarm-proxy.service.ts's confighash convention. */
export function appEnvConfigHash(env: Record<string, string>): string {
  const body = Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join("\n");
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

/** Total rollout poll budget, scaled to the replica count. A flat 300s is far too short for N replicas
 *  updated one at a time (worst case ≈ N × update-monitor), which would make a fine deploy report FAILED
 *  purely from the WS command timing out mid-rollout. */
export function effectivePollSec(replicas: number, healthCmd?: string | null): number {
  const per = updateMonitorSec(healthCmd) + 15; // monitor window + task start/schedule slack
  return Math.min(900, 30 + Math.max(1, replicas) * per);
}

/**
 * Deploys an app as a Docker Swarm SERVICE (Phase3). Owns the swarm-specific command building + dispatch to
 * the cluster's MANAGER; the Deployment-row lifecycle (status/notify/logs) stays in ApplicationsService,
 * which calls `deploy()` and interprets the returned exit code with the SAME 0/3/other contract it uses for
 * the classic rolling/recreate paths. Manager is re-resolved fresh on every call — never snapshotted.
 */
@Injectable()
export class SwarmDeployService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly swarmProxy: SwarmProxyService,
  ) {}

  /** Resolve the live swarm manager for a cluster, or throw a clear error. DEGRADED is allowed (a live
   *  manager can still schedule); only NONE/FORMING/DISSOLVING block. */
  async resolveManager(clusterId: string): Promise<string> {
    const cluster = await this.prisma.cluster.findUnique({
      where: { id: clusterId },
      select: { swarmStatus: true, swarmManagerId: true },
    });
    if (!cluster) throw new BadRequestException("cluster not found");
    if (cluster.swarmStatus !== "ACTIVE" && cluster.swarmStatus !== "DEGRADED") {
      throw new BadRequestException(`cluster swarm is ${cluster.swarmStatus} — form the swarm before deploying`);
    }
    if (!cluster.swarmManagerId) throw new BadRequestException("cluster has no swarm manager");
    const mgr = await this.prisma.server.findUnique({ where: { id: cluster.swarmManagerId }, select: { status: true } });
    if (mgr && mgr.status === "ONLINE") return cluster.swarmManagerId; // fast path: primary online (unchanged)
    // FLEET-G failover: the primary is offline, but `docker service …` is cluster-wide from ANY manager — so
    // fall back to any other ONLINE manager with the 'swarm' capability for this cluster before giving up.
    const backup = await this.prisma.server.findFirst({
      where: { clusterId, swarmRole: "MANAGER", status: "ONLINE", capabilities: { has: "swarm" }, NOT: { id: cluster.swarmManagerId } },
      select: { id: true },
    });
    if (backup) return backup.id;
    throw new ServiceUnavailableException("swarm manager is offline");
  }

  /**
   * Build + push (GIT) then create/update the swarm service on the manager, polling to convergence.
   * Returns the combined output, exit code (0 converged / 3 auto-rolled-back / other failed) and the
   * swarm-pinned image digest. `spec` must already be env-resolved and have registryPush set for GIT.
   */
  async deploy(
    app: Application,
    spec: AppSpec,
    deploymentId: string,
    opts: { noCache?: boolean; timeoutMs: number; onChunk?: (c: string) => void } = { timeoutMs: 300_000 },
  ): Promise<{ exitCode: number; output: string; digest: string | null; registryRef: string | null }> {
    const managerId = await this.resolveManager(app.clusterId!);

    let ref: string;
    let auth = spec.registryAuth ?? null;
    let buildLog = "";
    let registryRef: string | null = null;

    if (app.source === "GIT") {
      if (!spec.registryPush) {
        throw new BadRequestException("a registry is required to deploy a GIT app to a swarm cluster");
      }
      // Build + push on the dedicated build server if set, else on the manager itself. The image MUST land
      // on a registry every node can pull from (a swarm task can be scheduled onto any node).
      const buildTarget = app.buildServerId ?? managerId;
      const br = await this.agentWs.sendCommand(
        buildTarget,
        buildBuildOnlyScript(spec, deploymentId, opts.noCache ?? false),
        "deploy",
        opts.timeoutMs,
        opts.onChunk,
      );
      buildLog = br.output;
      if (br.exitCode !== 0) throw new Error(`image build failed\n${br.output}`);
      ref = spec.registryPush.tag;
      auth = spec.registryPush.auth;
      registryRef = spec.registryPush.tag;
    } else {
      // IMAGE source: the upstream image is already registry-hosted; the manager logs in (if private) and
      // --with-registry-auth distributes the token to task nodes.
      ref = imageRef(spec);
    }

    // A routed (domain) swarm app needs the cluster's swarm-mode Traefik up before its service labels can be
    // discovered. Ensure it (idempotent; refuses on a classic-proxy collision) before deploying.
    if (spec.domain) await this.swarmProxy.ensure(app.clusterId!);

    const svc = await this.dispatchService(managerId, app, spec, ref, auth, opts.onChunk);
    const output = buildLog ? `${buildLog}\n${svc.output}` : svc.output;
    return { exitCode: svc.exitCode, output, digest: parseServiceImageDigest(output), registryRef };
  }

  /** Roll a swarm app back to a specific image ref (a prior deployment's registryImage/digest) WITHOUT
   *  rebuilding — a `docker service update --image <ref>` with the app's current config, mirroring the
   *  classic rollback philosophy (old image, current env/limits). */
  async rollbackTo(
    app: Application,
    spec: AppSpec,
    ref: string,
    auth: RegistryAuth | null,
    opts: { onChunk?: (c: string) => void } = {},
  ): Promise<{ exitCode: number; output: string; digest: string | null }> {
    const managerId = await this.resolveManager(app.clusterId!);
    // A routed app needs the swarm-mode Traefik up before rollback too (it may have gone down since the last
    // deploy, or the manager may have been replaced) — same as deploy().
    if (spec.domain) await this.swarmProxy.ensure(app.clusterId!);
    const svc = await this.dispatchService(managerId, app, spec, ref, auth, opts.onChunk);
    return { exitCode: svc.exitCode, output: svc.output, digest: parseServiceImageDigest(svc.output) };
  }

  /** Assemble the overlay-ensure + service create/update script and dispatch it to the manager. Shared by
   *  deploy() (freshly built/resolved ref) and rollbackTo() (a prior ref, no build). */
  private async dispatchService(
    managerId: string,
    app: Application,
    spec: AppSpec,
    ref: string,
    auth: RegistryAuth | null,
    onChunk?: (c: string) => void,
  ): Promise<{ exitCode: number; output: string }> {
    const replicas = Math.max(1, app.replicas ?? 1);
    const pollSec = effectivePollSec(replicas, spec.healthCmd);
    // A routed (domain) app is reached by the swarm-mode Traefik over the overlay via its SERVICE labels →
    // no host port. A domain-less app instead publishes a routing-mesh port (reachable on any-node:hostPort).
    const routed = !!spec.domain;
    const labels = routed ? traefikLabels(spec) : [];
    const publish = !routed && app.hostPort ? [`${app.hostPort}:${spec.containerPort ?? 80}`] : [];
    // Structured placement → rendered docker expressions (FLEET-D). Shared by deploy() and rollbackTo().
    const constraints = (spec.placementConstraints ?? []).map(constraintExpr);
    const placementPrefs = spec.placementSpreadLabelKey ? [spreadPrefExpr(spec.placementSpreadLabelKey)] : [];
    // FLEET-E: named-volume mounts for a stateful app, and a hard node-pin. The pin resolves the pinned
    // Server's LIVE swarm node id and adds a node.id== constraint alongside any user placement, so the app's
    // single replica always lands on the node holding its data.
    const mounts = (spec.volumes ?? []).map((v) => ({ source: appVolumeName(app, v.name), target: v.path }));
    if (app.constraintServerId) {
      const pinned = await this.prisma.server.findUnique({ where: { id: app.constraintServerId }, select: { swarmNodeId: true } });
      if (pinned?.swarmNodeId) {
        // The auto-pin clears user placement when it's set, so `constraints` is normally empty here; dedupe
        // defensively so we never emit the same node.id== flag twice.
        const pin = constraintExpr({ type: "nodeId", op: "eq", value: pinned.swarmNodeId });
        if (!constraints.includes(pin)) constraints.push(pin);
      }
    }
    // FLEET-F: move env into an encrypted Docker secret instead of plaintext in the Raft store — but ONLY if
    // the image has a shell to run the loader wrapper. Pull+inspect the image on the manager to learn its real
    // Entrypoint/Cmd (the wrapper must re-supply them) and whether it has a shell; a shell-less image
    // (distroless/scratch) falls back to the classic plaintext env path so it is never silently broken.
    const env = spec.env && typeof spec.env === "object" ? spec.env : {};
    let envSecret: AppEnvSecret | null = null;
    let imageEntrypoint: string[] = [];
    let imageCmd: string[] = [];
    let envFallbackNoShell = false;
    if (Object.keys(env).length > 0) {
      const insp = await this.agentWs.sendCommand(managerId, buildInspectEntrypointScript(ref, auth), "swarm", 120_000);
      if (insp.exitCode !== 0) throw new Error(`could not pull/inspect ${ref} to protect its env vars:\n${insp.output}`);
      const parsed = parseImageEntrypointCmd(insp.output);
      // Use a secret only when the image has a shell AND a real command to re-exec — an image with neither
      // entrypoint nor cmd can't be wrapped (`exec "$@"` would be a no-op → silent crash loop), so fall back.
      if (parsed.hasShell && (parsed.entrypoint.length > 0 || parsed.cmd.length > 0)) {
        const confighash = appEnvConfigHash(env);
        envSecret = { name: `${appEnvSecretPrefix(serviceName(app))}-${confighash}`, confighash, credsB64: envFileB64(env) };
        imageEntrypoint = parsed.entrypoint;
        imageCmd = parsed.cmd;
      } else {
        // shell-less/command-less image → keep env plaintext; flag it so a previously-WRAPPED service is
        // recreated (its stale sh-wrapper entrypoint can't be reset by `docker service update`).
        envFallbackNoShell = true;
      }
    }
    const script = [
      buildOverlayEnsureScript(SWARM_OVERLAY),
      buildServiceDeployScript({
        serviceName: serviceName(app),
        ref,
        replicas,
        network: SWARM_OVERLAY,
        env,
        envSecret,
        imageEntrypoint,
        imageCmd,
        envFallbackNoShell,
        registryAuth: auth,
        memoryMb: spec.memoryMb ?? null,
        cpus: spec.cpus ?? null,
        reserveMemoryMb: spec.reserveMemoryMb ?? null,
        reserveCpus: spec.reserveCpus ?? null,
        healthCmd: spec.healthCmd ?? null,
        labels,
        publish,
        constraints,
        placementPrefs,
        mounts,
        pollSec,
      }),
    ].join("\n");
    return this.agentWs.sendCommand(managerId, script, "swarm", (pollSec + 30) * 1000, onChunk);
  }

  // ── lifecycle (all dispatched to the cluster manager under the "swarm" capability) ──

  /** Scale (stop = 0, start = stored replica count) AND wait for convergence — same sizing/return shape as
   *  restart(), so stop/start actually confirms the tasks reached the target instead of returning the instant
   *  Swarm accepted the request. */
  async scale(app: Application, replicas: number): Promise<{ exitCode: number; output: string }> {
    const managerId = await this.resolveManager(app.clusterId!);
    const pollSec = effectivePollSec(Math.max(1, replicas), app.healthCmd);
    return this.agentWs.sendCommand(
      managerId,
      buildServiceScaleScript(serviceName(app), replicas, pollSec),
      "swarm",
      (pollSec + 30) * 1000,
    );
  }

  async restart(app: Application): Promise<{ exitCode: number; output: string }> {
    const managerId = await this.resolveManager(app.clusterId!);
    const replicas = Math.max(1, app.replicas ?? 1);
    const pollSec = effectivePollSec(replicas, app.healthCmd);
    return this.agentWs.sendCommand(
      managerId,
      buildServiceRestartScript(serviceName(app), replicas, pollSec),
      "swarm",
      (pollSec + 30) * 1000,
    );
  }

  async remove(app: Application): Promise<void> {
    const managerId = await this.resolveManager(app.clusterId!);
    await this.agentWs.sendCommand(managerId, buildServiceRemoveScript(serviceName(app)), "swarm");
  }

  async status(app: Application): Promise<{ exitCode: number; output: string }> {
    const managerId = await this.resolveManager(app.clusterId!);
    return this.agentWs.sendCommand(managerId, buildServicePsScript(serviceName(app)), "swarm");
  }

  async logs(app: Application, tail = 200, since?: string): Promise<{ exitCode: number; output: string }> {
    const managerId = await this.resolveManager(app.clusterId!);
    return this.agentWs.sendCommand(managerId, buildServiceLogsScript(serviceName(app), tail, since), "swarm");
  }

  /** Resolve a RUNNING replica to open a shell into: {serverId of the node hosting it, its container name}.
   *  Picks a node that is ONLINE and has the "terminal" capability (opt-in), preferring the manager (one
   *  round-trip). A swarm task can be rescheduled after this resolves (TOCTOU) — the exec just fails and the
   *  user retries; that's the same graceful-degradation the deploy path already accepts. */
  async resolveTaskExec(app: Application): Promise<{ serverId: string; container: string }> {
    const managerId = await this.resolveManager(app.clusterId!);
    const svc = serviceName(app);
    const ps = await this.agentWs.sendCommand(managerId, buildServicePsScript(svc), "swarm");
    if (ps.exitCode !== 0) throw new ServiceUnavailableException("could not list the service's tasks");
    // Nodes (by hostname) currently running a task of this service.
    const nodesRunning = new Set<string>();
    for (const line of ps.output.split("\n").map((l) => l.trim()).filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        if (String(j.CurrentState ?? "").startsWith("Running") && j.Node) nodesRunning.add(String(j.Node));
      } catch {
        /* skip malformed line */
      }
    }
    if (nodesRunning.size === 0) throw new BadRequestException("no running replica to open a shell into");

    const members = await this.prisma.server.findMany({
      where: { clusterId: app.clusterId! },
      select: { id: true, hostname: true, status: true, capabilities: true },
    });
    // Candidate = a member whose hostname runs a task, is ONLINE, and has "terminal" granted (opt-in cap).
    const candidates = members.filter(
      (m) => m.hostname && nodesRunning.has(m.hostname) && m.status === "ONLINE" && m.capabilities.includes("terminal"),
    );
    if (candidates.length === 0) {
      throw new BadRequestException("grant the 'terminal' capability to a node running this app's replicas to open a shell");
    }
    // Prefer the manager (single round-trip; likeliest to have terminal granted).
    const pick = candidates.find((m) => m.id === managerId) ?? candidates[0];
    // Use the "swarm" capability for the task-container lookup: it is GUARANTEED granted on any cluster
    // member (joinWorker refuses a node lacking it), whereas "deploy" is revocable independent of swarm
    // membership — using "deploy" here could fail with a confusing "deploy not granted" on a node an
    // operator deliberately locked down to just terminal + swarm.
    const r = await this.agentWs.sendCommand(pick.id, buildServiceTaskContainerScript(svc), "swarm");
    const container = r.output.split("\n").map((l) => l.trim()).find(Boolean);
    if (r.exitCode !== 0 || !container) throw new BadRequestException("could not resolve the replica's container");
    return { serverId: pick.id, container };
  }
}
