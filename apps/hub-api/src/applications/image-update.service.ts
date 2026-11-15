import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import type { Application } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentCommandTimeoutException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { CryptoService } from "../crypto/crypto.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SwarmDeployService } from "../clusters/swarm-deploy.service";
import { loadProjectCtx } from "../common/resource-project";
import type { RegistryAuth } from "../deploy/deploy-script";
import {
  computeImageUpdateView,
  isCheckableRef,
  isImageCheckSubject,
  loadLiveImageMany,
  parseRecordedDigest,
  refRepoKey,
  type ImageUpdateView,
  type LiveImage,
} from "./image-update";
import {
  IMAGE_PROBE_LOGIN_TIMEOUT_SEC,
  IMAGE_PROBE_MAX_ITEMS,
  IMAGE_PROBE_PER_ITEM_WORST_SEC,
  buildImageUpdateScript,
  parseImageUpdateOutput,
  type ImageProbeVerdict,
} from "./image-update-script";

const DEFAULT_INTERVAL_MIN = 360;
const BACKOFF_FAILURES = 3; // after this many consecutive failures an app is re-probed at most daily
const BACKOFF_MS = 24 * 60 * 60 * 1000;
const TICK_BUDGET_MS = 8 * 60 * 1000; // stop STARTING new probe batches after this (leftovers stay due)
const MANUAL_THROTTLE_MS = 30_000;
/** Hub-side command deadline = the script's REAL worst case: the bounded login + per ref one --format inspect and
 *  (only after a fast failure, never after a timeout) one --raw fallback, each capped by the script's own `timeout`. */
export const CMD_BASE_TIMEOUT_MS = (IMAGE_PROBE_LOGIN_TIMEOUT_SEC + 10) * 1000;
export const CMD_PER_ITEM_TIMEOUT_MS = (IMAGE_PROBE_PER_ITEM_WORST_SEC + 2) * 1000;
/** Refs per probe command (the script itself accepts up to IMAGE_PROBE_MAX_ITEMS). Kept small so one command's
 *  deadline stays well inside TICK_BUDGET_MS and a hung command costs a handful of refs, not 25. */
export const PROBE_CHUNK_SIZE = 10;

/** The columns the runner reads. A full Application row satisfies it too. */
export type ImageCheckCandidate = Pick<
  Application,
  | "id"
  | "teamId"
  | "name"
  | "image"
  | "status"
  | "serverId"
  | "clusterId"
  | "environmentId"
  | "registryAuthEnc"
  | "imageUpstreamDigest"
  | "imageUpstreamCheckedAt"
  | "imageUpstreamChangedAt"
  | "imageCheckFailures"
  | "imageUpdateNotifiedDigest"
>;

const CANDIDATE_SELECT = {
  id: true,
  teamId: true,
  name: true,
  image: true,
  status: true,
  serverId: true,
  clusterId: true,
  environmentId: true,
  registryAuthEnc: true,
  imageUpstreamDigest: true,
  imageUpstreamCheckedAt: true,
  imageUpstreamChangedAt: true,
  imageCheckFailures: true,
  imageUpdateNotifiedDigest: true,
} as const;

type Creds = { auth: RegistryAuth | null; hash: string } | "unreadable";

/**
 * "Image update available" probe runner. The hub never talks to a registry: a fixed hub-built script runs on the
 * app's own server through the signed deploy command channel (see image-update-script.ts) and returns the upstream
 * manifest digest, which is compared with the digest recorded at the last successful deploy.
 *
 * Fail closed everywhere: an undecryptable credential skips the app (no anonymous downgrade), a transport failure
 * or a missing marker writes nothing, and a failed probe never erases the last good upstream digest.
 */
@Injectable()
export class ImageUpdateService {
  private readonly logger = new Logger(ImageUpdateService.name);
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly crypto: CryptoService,
    private readonly notifications: NotificationsService,
    private readonly swarmDeploy: SwarmDeployService,
    private readonly config: ConfigService,
  ) {}

  /** Minutes between probes of one app; 0 = the whole feature is off (operator kill switch). */
  intervalMin(): number {
    const v = this.config.get<number>("IMAGE_UPDATE_CHECK_INTERVAL_MIN");
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_INTERVAL_MIN;
  }

  // ---------------------------------------------------------------- scheduled tick

  /** One tick over every eligible IMAGE app. Never throws. */
  async runTick(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      this.logger.warn(`image-update tick failed: ${String(e)}`);
    }
  }

  private async tick(): Promise<void> {
    const intervalMin = this.intervalMin();
    if (intervalMin === 0) return;
    const startedAt = Date.now();
    const apps = (await this.prisma.application.findMany({
      where: { source: "IMAGE", isPreview: false, imageUpdateCheck: true, image: { not: null }, status: { not: "NEW" } },
      select: CANDIDATE_SELECT,
      // Never-probed apps first, then the stalest: a group that keeps failing (and so keeps its old timestamp) cannot
      // permanently lead the tick and starve the groups behind it.
      orderBy: { imageUpstreamCheckedAt: { sort: "asc", nulls: "first" } },
    })) as ImageCheckCandidate[];
    if (!apps.length) return;
    const live = await loadLiveImageMany(this.prisma, apps.map((a) => a.id));
    const due = apps.filter((a) => this.isDue(a, live.get(a.id), intervalMin, startedAt));
    if (!due.length) return;

    // Resolve each due app's target server (the swarm manager for a clustered app) and its credentials.
    const managerByCluster = new Map<string, string | null>();
    const targets = new Map<string, { serverId: string; auth: RegistryAuth | null; byRef: Map<string, ImageCheckCandidate[]> }>();
    const candidateServers: string[] = [];
    const resolved: { app: ImageCheckCandidate; serverId: string; creds: { auth: RegistryAuth | null; hash: string } }[] = [];
    for (const app of due) {
      const creds = this.credsOf(app);
      if (creds === "unreadable") continue; // fail closed: never downgrade to an anonymous probe
      let serverId: string | null = app.serverId;
      if (app.clusterId) {
        if (!managerByCluster.has(app.clusterId)) {
          managerByCluster.set(app.clusterId, await this.swarmDeploy.resolveManager(app.clusterId).catch(() => null));
        }
        serverId = managerByCluster.get(app.clusterId) ?? null;
      }
      if (!serverId) continue;
      candidateServers.push(serverId);
      resolved.push({ app, serverId, creds });
    }
    if (!resolved.length) return;
    const servers = await this.prisma.server.findMany({ where: { id: { in: [...new Set(candidateServers)] } }, select: { id: true, status: true } });
    const onlineIds = new Set(servers.filter((s) => s.status === "ONLINE").map((s) => s.id));
    for (const r of resolved) {
      if (!onlineIds.has(r.serverId) || !this.agentWs.isOnline(r.serverId)) continue; // no write on skip
      const key = `${r.serverId}|${r.creds.auth ? r.creds.hash : "anon"}`;
      let g = targets.get(key);
      if (!g) {
        g = { serverId: r.serverId, auth: r.creds.auth, byRef: new Map() };
        targets.set(key, g);
      }
      const ref = r.app.image!;
      g.byRef.set(ref, [...(g.byRef.get(ref) ?? []), r.app]);
    }

    for (const g of targets.values()) {
      const refs = [...g.byRef.keys()];
      for (let i = 0; i < refs.length; i += PROBE_CHUNK_SIZE) {
        if (Date.now() - startedAt > TICK_BUDGET_MS) return; // leftovers stay due for the next tick
        const chunk = refs.slice(i, i + PROBE_CHUNK_SIZE);
        const probedAt = new Date();
        const verdicts = new Map<string, ImageProbeVerdict>();
        try {
          await this.probeResilient(g.serverId, g.auth, chunk, verdicts, startedAt + TICK_BUDGET_MS);
        } catch (e) {
          // Host-free, output-free warning: serverId + count only. Whatever verdicts were collected before the
          // failure are still applied below; the rest write nothing and stay due.
          this.logger.warn(`image-update probe skipped on server ${g.serverId} (${chunk.length} ref(s)): ${e instanceof Error ? e.constructor.name : "error"}`);
        }
        for (const [ref, verdict] of verdicts) {
          for (const app of g.byRef.get(ref) ?? []) {
            try {
              await this.applyVerdict(app, ref, verdict, probedAt, live.get(app.id));
            } catch (e) {
              this.logger.warn(`image-update apply failed for app ${app.id}: ${e instanceof Error ? e.constructor.name : "error"}`);
            }
          }
        }
      }
    }
  }

  /** Is this app due for a probe now? */
  private isDue(app: ImageCheckCandidate, live: LiveImage | undefined, intervalMin: number, now: number): boolean {
    if (!app.image || !isCheckableRef(app.image)) return false;
    const rec = live ? parseRecordedDigest(live.digest) : null;
    if (!live || !rec || rec.repoKey !== refRepoKey(app.image)) return false; // no baseline: nothing to compare against
    const checkedAt = app.imageUpstreamCheckedAt;
    if (!checkedAt) return true;
    if (checkedAt.getTime() < live.finishedAt.getTime()) return true; // deployed / rolled back since the last probe
    const interval = app.imageCheckFailures >= BACKOFF_FAILURES ? Math.max(intervalMin * 60_000, BACKOFF_MS) : intervalMin * 60_000;
    return checkedAt.getTime() < now - interval;
  }

  // ---------------------------------------------------------------- manual "Check now"

  /**
   * Manual probe for one app (the caller already enforced apps:deploy). Throttled to one probe per 30 s, concurrent
   * calls coalesce, and no script output or credential ever appears in a thrown message.
   */
  async checkApp(app: Application, canWrite = true): Promise<{ imageUpdate: ImageUpdateView }> {
    if (!isImageCheckSubject(app)) throw new BadRequestException("image update checks apply to deployed image apps only");
    if (!app.imageUpdateCheck) throw new BadRequestException("image update checks are turned off for this app");
    if (!isCheckableRef(app.image!)) throw new BadRequestException("this image is pinned to a digest — there is nothing to check");
    if (this.intervalMin() === 0) throw new ConflictException("image update checks are disabled by the operator");

    const view = async (): Promise<{ imageUpdate: ImageUpdateView }> => {
      const fresh = await this.prisma.application.findUnique({ where: { id: app.id } });
      const live = (await loadLiveImageMany(this.prisma, [app.id])).get(app.id);
      return { imageUpdate: computeImageUpdateView(fresh ?? app, live, canWrite) ?? this.fallbackView(app) };
    };

    const live = (await loadLiveImageMany(this.prisma, [app.id])).get(app.id);
    const rec = live ? parseRecordedDigest(live.digest) : null;
    // Nothing recorded to compare against (or the repo changed): a probe could not produce a verdict anyway.
    if (!live || !rec || rec.repoKey !== refRepoKey(app.image!)) return view();
    const recent = app.imageUpstreamCheckedAt && Date.now() - app.imageUpstreamCheckedAt.getTime() < MANUAL_THROTTLE_MS;
    if (recent && app.imageUpstreamCheckedAt!.getTime() >= live.finishedAt.getTime()) return view(); // cached

    const pending = this.inflight.get(app.id);
    if (pending) {
      await pending.catch(() => undefined);
      return view();
    }
    const run = this.runManual(app, live);
    this.inflight.set(app.id, run);
    try {
      await run;
    } finally {
      this.inflight.delete(app.id);
    }
    return view();
  }

  private async runManual(app: Application, live: LiveImage): Promise<void> {
    const creds = this.credsOf(app);
    if (creds === "unreadable") throw new BadRequestException("the stored registry credentials could not be read");
    let serverId: string | null = app.serverId;
    if (app.clusterId) serverId = await this.swarmDeploy.resolveManager(app.clusterId).catch(() => null);
    if (!serverId) throw new ConflictException("server is offline");
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { status: true } });
    if (!server || server.status !== "ONLINE" || !this.agentWs.isOnline(serverId)) throw new ConflictException("server is offline");
    const ref = app.image!;
    const probedAt = new Date();
    const verdicts = new Map<string, ImageProbeVerdict>();
    try {
      await this.probeResilient(serverId, creds.auth, [ref], verdicts, null);
    } catch (e) {
      if (e instanceof AgentOfflineException) throw new ConflictException("server is offline");
      throw new BadRequestException("could not reach the server agent");
    }
    const verdict = verdicts.get(ref);
    if (!verdict) throw new BadRequestException("could not reach the server agent");
    await this.applyVerdict(app, ref, verdict, probedAt, live);
  }

  private fallbackView(app: Application): ImageUpdateView {
    return { enabled: app.imageUpdateCheck, state: "no_baseline", updateAvailable: false, checkedAt: null, changedAt: null, error: null, upstreamDigest: null, deployedDigest: null };
  }

  // ---------------------------------------------------------------- probe + persist

  /**
   * probeChunk with isolation of a slow ref: when the hub's command deadline fires (a hung agent/registry path), the
   * chunk is bisected so one bad ref only costs itself. A single-ref chunk that still times out records the
   * `timeout` verdict through the normal path (failure counter + 24 h backoff apply to that ref alone). Verdicts are
   * collected into `out` as they arrive, so a later failure (offline, budget) keeps what was already learned.
   * Non-timeout errors (offline, no markers) propagate. `deadlineAt` bounds the bisection by the tick budget.
   */
  private async probeResilient(
    serverId: string,
    auth: RegistryAuth | null,
    refs: string[],
    out: Map<string, ImageProbeVerdict>,
    deadlineAt: number | null,
  ): Promise<void> {
    try {
      for (const [ref, v] of await this.probeChunk(serverId, auth, refs)) out.set(ref, v);
    } catch (e) {
      if (!(e instanceof AgentCommandTimeoutException)) throw e;
      if (refs.length === 1) {
        out.set(refs[0]!, { ok: false, code: "timeout" });
        return;
      }
      const mid = Math.ceil(refs.length / 2);
      for (const half of [refs.slice(0, mid), refs.slice(mid)]) {
        if (deadlineAt !== null && Date.now() > deadlineAt) return; // leftovers stay due
        await this.probeResilient(serverId, auth, half, out, deadlineAt);
      }
    }
  }

  /** Run the probe script for up to 25 refs on one server. Throws when nothing usable came back (no write). */
  private async probeChunk(serverId: string, auth: RegistryAuth | null, refs: string[]): Promise<Map<string, ImageProbeVerdict>> {
    const nonce = randomBytes(8).toString("hex");
    const script = buildImageUpdateScript(refs.map((ref, idx) => ({ idx, ref })), auth, nonce);
    const r = await this.agentWs.sendCommand(serverId, script, "deploy", CMD_BASE_TIMEOUT_MS + CMD_PER_ITEM_TIMEOUT_MS * refs.length);
    const parsed = parseImageUpdateOutput(r.output, nonce);
    if (parsed.size === 0) throw new Error("no markers in probe output");
    const out = new Map<string, ImageProbeVerdict>();
    for (const [idx, verdict] of parsed) {
      const ref = refs[idx];
      if (ref !== undefined) out.set(ref, verdict);
    }
    return out;
  }

  private async applyVerdict(app: ImageCheckCandidate, ref: string, verdict: ImageProbeVerdict, probedAt: Date, live: LiveImage | undefined): Promise<void> {
    if (verdict.ok) {
      const changed = verdict.digest !== app.imageUpstreamDigest;
      // CAS on `image`: a concurrent source edit can't receive a verdict for the old ref.
      const r = await this.prisma.application.updateMany({
        where: { id: app.id, image: ref },
        data: {
          imageUpstreamDigest: verdict.digest,
          imageUpstreamCheckedAt: probedAt,
          imageCheckError: null,
          imageCheckFailures: 0,
          ...(changed ? { imageUpstreamChangedAt: probedAt } : {}),
        },
      });
      if (r.count === 0) return;
      await this.maybeNotify(app, ref, verdict.digest, probedAt, live);
      return;
    }
    // A failed probe keeps the previous digest and its changedAt (never erase a good observation).
    await this.prisma.application.updateMany({
      where: { id: app.id, image: ref },
      data: { imageCheckError: verdict.code, imageUpstreamCheckedAt: probedAt, imageCheckFailures: { increment: 1 } },
    });
  }

  /**
   * Notify once per new upstream digest. The first successful probe (or the first after a source edit / the upgrade)
   * seeds the dedupe column silently, so a fleet upgrade produces zero notifications. At-most-once: a crash between
   * the CAS and the enqueue loses one notification rather than duplicating it.
   */
  private async maybeNotify(app: ImageCheckCandidate, ref: string, upstream: string, probedAt: Date, live: LiveImage | undefined): Promise<void> {
    try {
      if (app.imageUpdateNotifiedDigest === null) {
        await this.prisma.application.updateMany({ where: { id: app.id, imageUpdateNotifiedDigest: null }, data: { imageUpdateNotifiedDigest: upstream } });
        return;
      }
      if (app.imageUpdateNotifiedDigest === upstream) return;
      const view = computeImageUpdateView(
        {
          source: "IMAGE",
          isPreview: false,
          image: ref,
          status: app.status,
          imageUpdateCheck: true,
          imageUpstreamDigest: upstream,
          imageUpstreamCheckedAt: probedAt,
          imageUpstreamChangedAt: probedAt,
          imageCheckError: null,
        },
        live,
        true,
      );
      if (view?.state !== "update_available") return;
      const claim = await this.prisma.application.updateMany({
        where: { id: app.id, OR: [{ imageUpdateNotifiedDigest: null }, { imageUpdateNotifiedDigest: { not: upstream } }] },
        data: { imageUpdateNotifiedDigest: upstream },
      });
      if (claim.count !== 1) return; // another replica (or tick) already claimed this digest
      const pctx = await loadProjectCtx(this.prisma, app.environmentId).catch(() => ({ projectId: null, projectName: null, environmentName: null }));
      // ctx carries only these fields: no credentials, probe output or log text.
      await this.notifications.fireForEvent(app.teamId, "image_update_available", {
        appId: app.id,
        appName: app.name,
        image: ref,
        deployedDigest: view.deployedDigest ?? "",
        upstreamDigest: upstream,
        projectName: pctx.projectName,
        environmentName: pctx.environmentName,
      });
    } catch (e) {
      this.logger.warn(`image-update notify failed for app ${app.id}: ${e instanceof Error ? e.constructor.name : "error"}`);
    }
  }

  // ---------------------------------------------------------------- credentials

  /** The app's decrypted registry credentials (+ an in-memory-only group hash), null auth when it has none, or
   *  "unreadable" when stored credentials can't be decrypted/parsed (the caller must skip: fail closed). */
  private credsOf(app: Pick<Application, "registryAuthEnc">): Creds {
    if (!app.registryAuthEnc) return { auth: null, hash: "anon" };
    try {
      const a = JSON.parse(this.crypto.decrypt(app.registryAuthEnc)) as unknown;
      if (!a || typeof a !== "object") return "unreadable";
      const { url, user, token } = a as Record<string, unknown>;
      if (typeof user !== "string" || typeof token !== "string" || (url !== undefined && typeof url !== "string")) return "unreadable";
      const auth: RegistryAuth = { ...(typeof url === "string" ? { url } : {}), user, token };
      return { auth, hash: createHash("sha256").update(JSON.stringify(auth)).digest("hex") };
    } catch {
      return "unreadable";
    }
  }
}
