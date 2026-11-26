import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import type { TakeoverCertState, TakeoverFailureCode, TakeoverStatus, TakeoverView } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CUTOVER_HOSTNAME_RE } from "../cutover/cutover.logic";
import { buildProxyStopScript } from "../deploy/deploy-script";
import { dbContainerName } from "../databases/database-script";
import { coolifyRefOf } from "../importer/sources/coolify-control";
import { buildSourceInspectScript, buildSourceStartScript, buildSourceStopScript, parseSourceInspect, parseStartOutput, parseStopOutput } from "../migration-runs/steps/data/source-control/source-scripts";
import type { CoolifyProxySnapshot } from "../migration-runs/steps/cutover/proxy-swap";
import { inspectSourceProxy, reverseSwapOnHost, stopSourceProxy, swapHostState, targetPublishesWeb } from "../migration-runs/steps/cutover/swap-runtime";
import {
  CERT_BATCH,
  CERT_MAX_ATTEMPTS,
  adoptTagFor,
  canGiveBack,
  canTakeoverTransition,
  cleanCommit,
  ctrsOf,
  hasCtrs,
  stopCtrs,
  domainsOf,
  certWorkLeft,
  isVerified,
  overdueFallbacks,
  judgeProbe,
  mapDbMounts,
  mapMounts,
  sameImageRef,
  swapGate,
  toItemView,
  type TakeoverItem,
} from "./inplace-plan";
import {
  buildAdoptImageScript,
  buildContainerDetailScript,
  buildDbFingerprintScript,
  buildFallbackInstallScript,
  buildFallbackRemoveScript,
  buildInPlaceProbeScript,
  buildNewCertCheckScript,
  buildRestartPolicyScript,
  buildVolumeAliasScript,
  checkLevelOf,
  isFingerprintEngine,
  isNewLetsEncryptCert,
  parseDbFingerprint,
  parseAdopt,
  parseAlias,
  parseContainerDetail,
  parseFallbackInstall,
  parseInPlaceProbe,
  parseNewCertCheck,
  parsePolicy,
  sameDatabase,
  type CtrDetail,
  type DbFingerprint,
  type DbTarget,
  type ProbeResult,
  type ProbeVia,
  type RecordedCtr,
} from "./inplace-scripts";
import { INPLACE_WORLD, type InPlaceWorld, type OpService } from "./inplace-world";
import { buildImageIdsScript, buildServiceDetailScript, buildServiceReadyScript, buildServiceVolumeScript, parseImageIds, parseServiceDetail, parseServiceReady, type ServiceVolumeAlias } from "./inplace-service-scripts";
import { engineOfImage, judgeReady, mapNetworks, mapServiceMounts, memberLevel, memberSame, parseServiceCompose, sameNetworkRows, startOrder, type MemberProbe, type ServiceCtrFacts, type ServiceMemberRecord } from "./inplace-service";
import type { GiveBackInput, PlanInput, SwapInput } from "./dto";
import type { InPlaceRunPort, RunTakeoverState } from "./inplace-run";

const OWNER_ONLY: Role[] = [Role.OWNER];
const HOST_T = 60_000;
/** Time for one batch of probes: each host is fetched up to twice at 10 s, plus slack. */
const probeTimeout = (n: number): number => Math.min(600_000, 15_000 + n * 2 * 10_000);
const PROBE_CHUNK = 10;
/** How long a service's containers are waited for to be ready (polls of 5 s, two minutes). */
const READY_POLLS = 24;
const READY_POLL_MS = 5_000;
/** How long a new certificate is waited for per domain (polls of 5 s). */
const CERT_POLLS = 12;
const CERT_POLL_MS = 5_000;

interface Row {
  id: string;
  teamId: string;
  serverId: string;
  actorId: string;
  sessionId: string | null;
  runId: string | null;
  status: string;
  tempPort: number | null;
  plan: Prisma.JsonValue;
  rollback: Prisma.JsonValue;
  items: Prisma.JsonValue;
  giveBackAvailable: boolean;
  failureCode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** What was found at plan time and is never changed: the Coolify proxy that will be stopped. Names and ids only. */
interface PlanDoc {
  opId: string;
  serverName: string;
  proxy: CoolifyProxySnapshot;
}

/** What has been done to the box, written BEFORE each effect so a crash still leaves the way back. */
interface Rollback {
  bindBefore: string;
  proxyBefore: "running" | "stopped" | "absent" | "unknown";
  darkStarted: boolean;
  exclusiveStopped: boolean;
  swapStarted: boolean;
}

const emptyRollback = (): Rollback => ({ bindBefore: "public", proxyBefore: "unknown", darkStarted: false, exclusiveStopped: false, swapStarted: false });

const unprocessable = (code: string, extra: Record<string, unknown> = {}): UnprocessableEntityException => new UnprocessableEntityException({ statusCode: 422, message: code, code, ...extra });

/** The proxy states `inspectSourceProxy` can refuse with, as the codes the owner sees. */
const PROXY_REFUSAL: Record<string, string> = {
  "control-plane": "takeover_control_plane",
  absent: "takeover_proxy_absent",
  name: "takeover_proxy_identity",
  image: "takeover_proxy_identity",
  ports: "takeover_proxy_identity",
  unreadable: "takeover_proxy_unreadable",
};

const recorded = (i: TakeoverItem): RecordedCtr => {
  const c = i.container as NonNullable<TakeoverItem["container"]>;
  return { id: c.id, name: c.name, image: c.image };
};
const recordedFull = (i: TakeoverItem) => ({ ...recorded(i), ports: "", itemRef: i.itemRef });

/**
 * Take a server over in place (Coolify hub takeover, lane F), one app container at a time and the proxy last:
 *
 *  1. plan   - read what Coolify runs on the box (read-only) and which Tugra app each container belongs to,
 *  2. test   - adopt the image Coolify already built, start Tugra's copy next to it where the data allows, start Tugra's proxy with no
 *              published port, and test every domain by Host header against what Coolify answered (status and content hash),
 *  3. swap   - only when every test passed and the owner typed the server's name: apps that share data with Coolify's copy are switched
 *              (Coolify's stopped, Tugra's started on the same data), Coolify's certificates are put in place as a fallback, Coolify's
 *              proxy is stopped and Tugra's takes the ports; every domain is checked again,
 *  4. verify - for each domain the fallback is taken away and a NEW Let's Encrypt certificate is waited for; if it does not come the
 *              fallback goes back and the domain is not marked done,
 *  5. give back - one step reverses everything above: Tugra's copies stop, Coolify's containers and proxy start as they were.
 *
 * Nothing is built (unless the owner chose it for an app), copied or deleted. Team OWNER only, every action audited with counts and codes;
 * no environment value, key or certificate leaves the host. The Coolify containers, images and volumes are only stopped and started, never removed.
 */
@Injectable()
export class CoolifyInPlaceService implements InPlaceRunPort {
  private readonly active = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    @Inject(INPLACE_WORLD) private readonly world: InPlaceWorld,
  ) {}

  // ───────────────────────────── plan ─────────────────────────────

  async plan(userId: string, input: PlanInput, link: { runId?: string } = {}): Promise<TakeoverView> {
    const server = await this.world.server(input.serverId);
    if (!server) throw new NotFoundException("server-not-found");
    await this.requireOwner(userId, server.teamId);
    if (server.status !== "ONLINE") throw unprocessable("takeover_server_offline");
    if (!server.capabilities.includes("deploy")) throw unprocessable("takeover_capability");
    // A takeover that was only planned changed nothing on the box: planning again (say, with another rebuild choice) replaces it instead of
    // being refused because of it. A run's takeover is the run's: it is never replaced from here.
    if (!link.runId) {
      const replaced = await this.prisma.coolifyTakeover.deleteMany({ where: { serverId: server.id, status: "PLANNED", runId: null } });
      if (replaced.count > 0) await this.audit.log({ actor: userId, action: "coolify.takeover.replan", target: server.id, meta: { replaced: replaced.count } });
    }
    // the guided run that carries this takeover holds the server itself: it is not "another" holder
    if (await this.world.serverBusy(server.id, link.runId)) throw new ConflictException("takeover_server_busy");

    const opApps = await this.world.opApps(input.opId, server.teamId, server.id);
    if (!opApps) throw new NotFoundException("op-not-found");
    const opDbs = (await this.world.opDatabases(input.opId, server.teamId, server.id)) ?? [];
    const opSvcs = (await this.world.opServices(input.opId, server.teamId, server.id)) ?? [];
    if (opApps.length === 0 && opDbs.length === 0 && opSvcs.length === 0) throw unprocessable("takeover_no_apps");
    const known = new Set(opApps.map((a) => a.itemRef));
    for (const r of input.rebuild) if (!known.has(r)) throw unprocessable("takeover_unknown_item", { itemRef: r });

    const proxy = await inspectSourceProxy(this.host, server.id);
    if (!proxy.ok) throw unprocessable(PROXY_REFUSAL[proxy.code] ?? "takeover_proxy_identity", { reason: proxy.code });
    if (!proxy.snapshot.running) throw unprocessable("takeover_proxy_not_running");
    // Tugra's proxy is started with no published port for the test. If it already runs here on a real bind (behind a front proxy, say), restarting
    // it would take the apps it serves down, so the takeover does not start; a proxy that is already dark (bind none) is harmless to restart.
    const tugraProxy = await this.world.proxyStatus(userId, server.id).catch(() => "unknown" as const);
    if (server.proxyBind !== "none" && (tugraProxy === "running" || tugraProxy === "unknown")) throw unprocessable("takeover_tugra_proxy_in_use");

    const items = await this.readItems(server.teamId, server.id, opApps, new Set(input.rebuild), opDbs, opSvcs);
    const doc: PlanDoc = { opId: input.opId, serverName: server.name, proxy: proxy.snapshot };
    const row = await this.prisma.coolifyTakeover.create({
      data: {
        teamId: server.teamId,
        serverId: server.id,
        actorId: userId,
        ...(link.runId ? { runId: link.runId } : {}),
        status: "PLANNED",
        plan: doc as unknown as Prisma.InputJsonValue,
        rollback: emptyRollback() as unknown as Prisma.InputJsonValue,
        items: items as unknown as Prisma.InputJsonValue,
        giveBackAvailable: true,
      },
    });
    await this.audit.log({ actor: userId, action: "coolify.takeover.plan", target: row.id, meta: { serverId: server.id, ...(link.runId ? { runId: link.runId } : {}), apps: items.filter((i) => i.kind !== "database" && i.kind !== "service").length, databases: items.filter((i) => i.kind === "database").length, services: items.filter((i) => i.kind === "service").length, skipped: items.filter((i) => i.state === "skipped").length, rebuild: items.filter((i) => i.buildMode === "rebuild-verify").length } });
    return this.view(row as Row);
  }

  /** What Coolify runs for each app of the op, mapped to the Tugra app. Read-only on the host. Apps that cannot be taken over are kept, marked skipped, with the reasons. */
  private async readItems(teamId: string, serverId: string, apps: ReadonlyArray<{ appId: string; itemRef: string; containerPrefix?: string; commitSha?: string | null }>, rebuild: ReadonlySet<string>, dbs: ReadonlyArray<{ databaseId: string; itemRef: string }> = [], svcs: readonly OpService[] = []): Promise<TakeoverItem[]> {
    const withRef = [...apps.map((a) => ({ itemRef: a.itemRef, containerPrefix: a.containerPrefix })), ...dbs.map((d) => ({ itemRef: d.itemRef, containerPrefix: undefined })), ...svcs.map((x) => ({ itemRef: x.itemRef, containerPrefix: undefined }))].filter((a) => coolifyRefOf(a.itemRef));
    let found: ReturnType<typeof parseSourceInspect> = [];
    if (withRef.length > 0) {
      try {
        const targets = withRef.map((a) => ({ itemRef: a.itemRef, ...(a.containerPrefix ? { containerPrefix: a.containerPrefix } : {}) }));
        const r = await this.world.exec(serverId, buildSourceInspectScript(targets), HOST_T);
        found = parseSourceInspect(r.output, targets).filter((c) => c.state === "running");
      } catch {
        throw unprocessable("takeover_host_unreadable");
      }
    }
    const byRef = new Map<string, typeof found>();
    for (const c of found) byRef.set(c.itemRef, [...(byRef.get(c.itemRef) ?? []), c]);
    const svcRefs = new Set(svcs.map((x) => x.itemRef));
    const single = [...byRef.entries()].flatMap(([ref, l]) => (l.length === 1 && !svcRefs.has(ref) ? [l[0]] : []));
    let detail = new Map<string, CtrDetail>();
    if (single.length > 0) {
      const r = await this.world.exec(serverId, buildContainerDetailScript(single.map((c) => ({ id: c.id, name: c.name, image: c.image }))), HOST_T);
      const parsed = parseContainerDetail(r.output, single.map((c) => c.id));
      if (!parsed) throw unprocessable("takeover_host_unreadable");
      detail = parsed;
    }

    const items: TakeoverItem[] = [];
    for (const a of apps) {
      const app = await this.world.app(a.appId);
      if (!app || app.teamId !== teamId || app.serverId !== serverId) continue;
      const hosts = [...new Set(app.hosts.map((h) => h.trim().toLowerCase()).filter((h) => CUTOVER_HOSTNAME_RE.test(h)))];
      const base: TakeoverItem = {
        itemRef: a.itemRef,
        name: app.name,
        buildMode: rebuild.has(a.itemRef) ? "rebuild-verify" : "reuse-image",
        domains: hosts.map((host) => ({ host, tempCheck: "pending" as const, finalCheck: "pending" as const, cert: "pending" as const })),
        appId: app.id,
        uuid: coolifyRefOf(a.itemRef)?.uuid ?? "",
        commitSha: cleanCommit(a.commitSha),
        container: null,
        volumes: [],
        binds: 0,
        exclusive: false,
        adoptDeploymentId: null,
        adoptTag: null,
        rebuildDeploymentId: null,
        state: "planned",
        issues: [],
        baseline: {},
        fallbackSerial: {},
        fallbackAt: {},
        certAttempts: {},
      };
      const skip = (...issues: TakeoverItem["issues"]): void => {
        items.push({ ...base, state: "skipped", issues });
      };
      if (hosts.length === 0) {
        skip("no_domain");
        continue;
      }
      const list = byRef.get(a.itemRef) ?? [];
      if (list.length === 0) {
        skip("container_absent");
        continue;
      }
      const d = list.length === 1 ? detail.get(list[0].id) : undefined;
      if (!d) {
        skip("container_changed");
        continue;
      }
      const m = mapMounts(d, app);
      if (m.issues.length > 0) {
        skip(...m.issues);
        continue;
      }
      if (rebuild.has(a.itemRef) && m.exclusive) throw unprocessable("takeover_rebuild_needs_side_by_side", { itemRef: a.itemRef });
      items.push({ ...base, container: { id: list[0].id, name: list[0].name, image: list[0].image, restart: d.restart, imageId: d.imageId }, volumes: m.volumes, binds: m.binds, exclusive: m.exclusive });
    }
    const dbItems = await this.readDbItems(teamId, serverId, dbs, byRef, detail);
    items.push(...dbItems);
    items.push(...(await this.readServiceItems(teamId, serverId, svcs, byRef)));
    await this.markAfterSwitch(items);
    return items;
  }

  /**
   * The databases the import created on the box, mapped to the containers Coolify runs for them. Always switched (their data is shared with
   * Coolify's container), never tested alongside. One that cannot be taken over is kept, marked skipped, with the reason.
   */
  private async readDbItems(teamId: string, serverId: string, dbs: ReadonlyArray<{ databaseId: string; itemRef: string }>, byRef: ReadonlyMap<string, Array<{ id: string; name: string; image: string }>>, detail: ReadonlyMap<string, CtrDetail>): Promise<TakeoverItem[]> {
    const out: TakeoverItem[] = [];
    for (const d of dbs) {
      const db = await this.world.database(d.databaseId);
      if (!db || db.teamId !== teamId || db.serverId !== serverId) continue;
      const base: TakeoverItem = {
        itemRef: d.itemRef,
        name: db.name,
        kind: "database",
        buildMode: "reuse-image",
        domains: [],
        appId: db.id,
        uuid: coolifyRefOf(d.itemRef)?.uuid ?? "",
        commitSha: null,
        container: null,
        volumes: [],
        binds: 0,
        exclusive: true,
        engine: db.engine,
        adoptDeploymentId: null,
        adoptTag: null,
        rebuildDeploymentId: null,
        state: "planned",
        issues: [],
        baseline: {},
        fallbackSerial: {},
        fallbackAt: {},
        certAttempts: {},
      };
      const skip = (issue: TakeoverItem["issues"][number]): void => {
        out.push({ ...base, state: "skipped", issues: [issue] });
      };
      if (!isFingerprintEngine(db.engine)) {
        skip("db_engine_unsupported");
        continue;
      }
      const list = byRef.get(d.itemRef) ?? [];
      if (list.length === 0) {
        skip("container_absent");
        continue;
      }
      const dt = list.length === 1 ? detail.get(list[0].id) : undefined;
      if (!dt) {
        skip("container_changed");
        continue;
      }
      if (!sameImageRef(db.image, list[0].image)) {
        skip("db_image_differs");
        continue;
      }
      const m = mapDbMounts(dt, db);
      if (m.issues.length > 0) {
        out.push({ ...base, state: "skipped", issues: m.issues });
        continue;
      }
      out.push({ ...base, verify: { level: checkLevelOf(db.engine), state: "pending" }, container: { id: list[0].id, name: list[0].name, image: list[0].image, restart: dt.restart, imageId: dt.imageId }, volumes: m.volumes });
    }
    return out;
  }

  /**
   * The compose services the import created on the box, mapped to the containers Coolify runs for them. Every container of the service
   * becomes a member: a Tugra container of the compose app on the same image (checked by the image's id, not its tag), on the same data
   * (volumes and host folders aliased, no copy) and on the same network names. A service whose containers do not map one to one is left out
   * whole, with the reasons: switching half a stack would be worse than switching none. Read-only on the host.
   */
  private async readServiceItems(teamId: string, serverId: string, svcs: readonly OpService[], byRef: ReadonlyMap<string, Array<{ id: string; name: string; image: string }>>): Promise<TakeoverItem[]> {
    const out: TakeoverItem[] = [];
    for (const s of svcs) {
      const svc = await this.world.service(s.appId);
      if (!svc || svc.teamId !== teamId || svc.serverId !== serverId) continue;
      const hosts = [...new Set(svc.hosts.map((h) => h.trim().toLowerCase()).filter((h) => CUTOVER_HOSTNAME_RE.test(h)))];
      const base: TakeoverItem = {
        itemRef: s.itemRef,
        name: svc.name,
        kind: "service",
        buildMode: "reuse-image",
        domains: hosts.map((host) => ({ host, tempCheck: "pending" as const, finalCheck: "pending" as const, cert: "pending" as const })),
        appId: svc.id,
        uuid: coolifyRefOf(s.itemRef)?.uuid ?? "",
        commitSha: null,
        container: null,
        volumes: [],
        binds: 0,
        exclusive: false,
        members: [],
        project: svc.project,
        adoptDeploymentId: null,
        adoptTag: null,
        rebuildDeploymentId: null,
        state: "planned",
        issues: [],
        baseline: {},
        fallbackSerial: {},
        fallbackAt: {},
        certAttempts: {},
      };
      const skip = (...issues: TakeoverItem["issues"]): void => {
        out.push({ ...base, state: "skipped", issues });
      };
      const compose = svc.usable ? parseServiceCompose(svc.composeFile) : null;
      if (!compose) {
        skip("service_compose_unsupported");
        continue;
      }
      const list = byRef.get(s.itemRef) ?? [];
      if (list.length === 0) {
        skip("container_absent");
        continue;
      }
      let facts: ReturnType<typeof parseServiceDetail> = null;
      try {
        facts = parseServiceDetail((await this.world.exec(serverId, buildServiceDetailScript(list.map((c) => ({ id: c.id, name: c.name, image: c.image }))), HOST_T)).output, list);
      } catch {
        facts = null;
      }
      if (!facts) throw unprocessable("takeover_host_unreadable");
      if (list.some((c) => !facts?.has(c.id))) {
        skip("container_changed");
        continue;
      }
      // every container maps to a compose service of the Tugra app, once, and every compose service has its container
      const issues = new Set<TakeoverItem["issues"][number]>();
      const byService = new Map<string, ServiceCtrFacts[]>();
      for (const f of facts.values()) {
        if (!f.service || !(f.service in compose)) issues.add("service_member_unmapped");
        else byService.set(f.service, [...(byService.get(f.service) ?? []), f]);
      }
      for (const l of byService.values()) if (l.length > 1) issues.add("service_member_ambiguous");
      for (const k of Object.keys(compose)) if (!byService.has(k)) issues.add("service_member_absent");
      if (issues.size > 0) {
        skip(...issues);
        continue;
      }
      const order = startOrder(compose);
      // the same image: the one the compose runs the service on must be, by id, the one Coolify's container runs
      const images = order.map((k) => compose[k].image);
      if (images.some((i) => i === null || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(i))) {
        skip("service_image_differs");
        continue;
      }
      const refs = [...new Set(images as string[])];
      const ids = await this.run(serverId, buildImageIdsScript(refs), (o) => parseImageIds(o, refs));
      if (!ids) throw unprocessable("takeover_host_unreadable");
      if (refs.some((r) => ids.get(r) === "missing")) {
        skip("image_missing");
        continue;
      }
      if (order.some((k) => ids.get(compose[k].image as string) !== (byService.get(k) as ServiceCtrFacts[])[0].imageId)) {
        skip("service_image_moved");
        continue;
      }
      let exclusive = false;
      const members: ServiceMemberRecord[] = [];
      for (const k of order) {
        const f = (byService.get(k) as ServiceCtrFacts[])[0];
        const m = mapServiceMounts(f.mounts, compose[k], svc.composeVolumes);
        for (const i of m.issues) issues.add(i);
        if (m.exclusive || f.published > 0) exclusive = true; // shared writable data, or a host port the two copies would fight for
        const engine = engineOfImage(f.image);
        members.push({
          service: k,
          container: { id: f.id, name: f.name, image: f.image, restart: f.restart, imageId: f.imageId },
          composeImage: compose[k].image as string,
          volumes: m.volumes,
          binds: m.binds,
          ...(engine ? { engine } : {}),
          ready: "pending",
        });
      }
      const nets = mapNetworks(members.map((m) => ({ service: m.service, container: m.container, networks: (byService.get(m.service) as ServiceCtrFacts[])[0].networks })), svc.networks, base.uuid);
      for (const i of nets.issues) issues.add(i);
      if (issues.size > 0) {
        skip(...issues);
        continue;
      }
      out.push({ ...base, members, exclusive, ...(sameNetworkRows(nets.rows, svc.networks) ? {} : { networksWanted: nets.rows }) });
    }
    return out;
  }

  /**
   * An app that talks to a database that is taken over cannot be tested alongside: the database is not there for Tugra's copy until the
   * switch. Judged from the app's environment (names only, never values kept); an environment that cannot be read counts as talking to it.
   */
  private async markAfterSwitch(items: TakeoverItem[]): Promise<void> {
    const dbs = items.filter((i) => i.kind === "database" && i.state !== "skipped");
    if (dbs.length === 0) return;
    const needles = dbs.flatMap((i) => [dbContainerName({ id: i.appId }), ...(i.uuid ? [i.uuid] : [])]);
    for (const i of items) {
      if (i.kind === "database" || i.state === "skipped" || i.exclusive) continue;
      const m = await this.world.appMentions(i.appId, needles);
      if (m !== false) i.afterSwitch = true;
    }
  }

  // ───────────────────────────── test ─────────────────────────────

  /**
   * Prepare Tugra's side and test it. Idempotent: it may be pressed again after a fix. Nothing on the box's public ports changes: Tugra's
   * proxy is started with no published port and answers on its own bridge address. A takeover that failed before the swap is tested again from here.
   */
  async test(userId: string, id: string): Promise<TakeoverView> {
    return this.exclusive(id, async () => {
      const { row, server } = await this.acting(userId, id);
      this.requireTransition(row.status, "TESTING");
      if (portsOwnedByTugra(row)) throw new ConflictException("takeover_already_swapped");
      const items = this.itemsOf(row);
      if (items.some((i) => i.state === "given-back")) throw new ConflictException("takeover_plan_again"); // it was reversed: plan a new one
      const rb = this.rollbackOf(row);
      await this.setStatus(row, "TESTING", null);

      if (!rb.darkStarted) {
        // recorded before the effect: whatever happens next, the give-back knows what the proxy was
        rb.bindBefore = server.proxyBind;
        rb.proxyBefore = await this.world.proxyStatus(userId, server.id).catch(() => "unknown" as const);
        await this.saveRollback(row.id, rb);
        await this.world.setProxyBind(server.id, "none");
        await this.world.startProxy(userId, server.id);
        rb.darkStarted = true;
        await this.saveRollback(row.id, rb);
      }

      for (const item of items) {
        if (item.state === "planned") await this.prepare(userId, row, items, item);
      }
      const active = items.filter((i) => i.state !== "skipped");
      const failure = await this.measure(server.id, active);
      await this.saveItems(row.id, items);
      await this.prisma.coolifyTakeover.update({ where: { id: row.id }, data: { failureCode: failure } });
      await this.audit.log({ actor: userId, action: "coolify.takeover.test", target: row.id, meta: { apps: active.length, ready: active.filter((i) => i.state === "prepared").length, domains: domainsOf(items).length, failure } });
      return this.fresh(row.id);
    });
  }

  /** Adopt the image, alias the volumes and, when the data allows it, start Tugra's copy. A failure marks the app skipped with its reason; the rest go on. */
  private async prepare(userId: string, row: Row, items: TakeoverItem[], item: TakeoverItem): Promise<void> {
    const serverId = row.serverId;
    const save = () => this.saveItems(row.id, items);
    const skip = async (issue: TakeoverItem["issues"][number]): Promise<void> => {
      item.state = "skipped";
      item.issues = [...new Set([...item.issues, issue])];
      await save();
    };

    if (item.kind === "database") return this.prepareDb(row, items, item);
    if (item.kind === "service") return this.prepareService(userId, row, items, item);

    if (item.buildMode === "rebuild-verify") {
      if (!item.rebuildDeploymentId) {
        item.rebuildDeploymentId = (await this.world.rebuild(userId, item.appId)).deploymentId;
        await save();
        return; // building: the next test reads how it went
      }
      const st = await this.world.deployState(item.rebuildDeploymentId);
      if (st === "FAILED") return skip("rebuild_failed");
      if (st === "SUCCESS") {
        item.state = "prepared";
        await save();
      }
      return;
    }

    const ctr = item.container;
    if (!ctr) return skip("container_absent");
    if (!item.adoptDeploymentId) {
      item.adoptDeploymentId = await this.world.createAdoptDeployment(item.appId, item.commitSha);
      item.adoptTag = adoptTagFor(item.appId, item.adoptDeploymentId);
      await save();
    }
    const adopt = await this.run(serverId, buildAdoptImageScript({ image: ctr.image, tag: item.adoptTag as string }), parseAdopt);
    if (adopt !== "ok") {
      await this.world.dropAdoptDeployment(item.adoptDeploymentId).catch(() => undefined);
      item.adoptDeploymentId = null;
      item.adoptTag = null;
      return skip(adopt === "missing" ? "image_missing" : "adopt_failed");
    }
    if (item.volumes.length > 0) {
      const targets = item.volumes.map((v) => v.to);
      const res = await this.run(serverId, buildVolumeAliasScript(item.volumes), (o) => parseAlias(o, targets));
      if (!res) return skip("volume_alias_failed");
      for (const t of targets) {
        const r = res.get(t);
        if (r === "foreign") return skip("volume_alias_foreign");
        if (r !== "created" && r !== "present") return skip("volume_alias_failed");
      }
    }
    // an app that shares data, or that talks to a database taken over with it, starts at the switch (the database is not there before)
    if (!item.exclusive && !item.afterSwitch) {
      const r = await this.world.runAdopted(userId, item.appId, item.adoptDeploymentId);
      if (!r.ok) return skip("prepare_failed");
    }
    item.state = "prepared";
    await save();
  }

  /**
   * A database: its Coolify volumes become aliases of the Tugra database's own volumes (no copy), and what Coolify's running container shows
   * is read once as the yardstick of the check after the switch. A database that cannot be read the way its engine is checked stays out: a
   * switch nobody could verify would be a guess.
   */
  private async prepareDb(row: Row, items: TakeoverItem[], item: TakeoverItem): Promise<void> {
    const save = () => this.saveItems(row.id, items);
    const skip = async (issue: TakeoverItem["issues"][number]): Promise<void> => {
      item.state = "skipped";
      item.issues = [...new Set([...item.issues, issue])];
      await save();
    };
    const ctr = item.container;
    if (!ctr || !isFingerprintEngine(item.engine ?? "")) return skip("container_absent");
    if (item.volumes.length > 0) {
      const targets = item.volumes.map((v) => v.to);
      const res = await this.run(row.serverId, buildVolumeAliasScript(item.volumes), (o) => parseAlias(o, targets));
      if (!res) return skip("volume_alias_failed");
      for (const t of targets) {
        const r = res.get(t);
        if (r === "foreign") return skip("volume_alias_foreign");
        if (r !== "created" && r !== "present") return skip("volume_alias_failed");
      }
    }
    if (!item.dbBefore) {
      const fps = await this.fingerprint(row.serverId, [{ engine: item.engine as DbTarget["engine"], ref: { kind: "recorded", ctr: recorded(item) } }]);
      const fp = fps?.get(ctr.id);
      if (!fp || fp.state !== "ok") return skip("db_verify_failed");
      item.dbBefore = fp;
    }
    item.state = "prepared";
    await save();
  }

  /**
   * A service: the images are checked to still be the ones Coolify's containers run (by id), the volumes and host folders of every container
   * become the compose app's volumes (no copy), what a database-like container shows is read once as the yardstick, and the compose stack is
   * adopted as a deployment so the rollback path can run it. A service that shares no writable data and publishes no host port runs alongside
   * Coolify's and is checked to be up; one that does is started at the switch. A failure marks the service skipped with its reason.
   */
  private async prepareService(userId: string, row: Row, items: TakeoverItem[], item: TakeoverItem): Promise<void> {
    const serverId = row.serverId;
    const members = item.members ?? [];
    const save = () => this.saveItems(row.id, items);
    const skip = async (issue: TakeoverItem["issues"][number]): Promise<void> => {
      item.state = "skipped";
      item.issues = [...new Set([...item.issues, issue])];
      await save();
    };
    if (members.length === 0 || !item.project) return skip("container_absent");

    // 1. the same images as the containers run, by id (a tag may have moved since the plan)
    const refs = [...new Set(members.map((m) => m.composeImage))];
    const ids = await this.run(serverId, buildImageIdsScript(refs), (o) => parseImageIds(o, refs));
    if (!ids) return skip("prepare_failed");
    if (refs.some((r) => ids.get(r) === "missing")) return skip("image_missing");
    if (members.some((m) => ids.get(m.composeImage) !== m.container.imageId)) return skip("service_image_moved");

    // 2. the data: every volume and folder of every container, aliased
    const byTarget = new Map<string, ServiceVolumeAlias>();
    for (const m of members) {
      for (const v of m.volumes) byTarget.set(v.to, { kind: "volume", from: v.from, to: v.to, project: item.project, key: v.key });
      for (const b of m.binds) byTarget.set(b.to, { kind: "bind", from: b.from, to: b.to, project: item.project, key: b.key });
    }
    if (byTarget.size > 0) {
      const targets = [...byTarget.keys()];
      const res = await this.run(serverId, buildServiceVolumeScript([...byTarget.values()]), (o) => parseAlias(o, targets));
      if (!res) return skip("volume_alias_failed");
      for (const t of targets) {
        const r = res.get(t);
        if (r === "foreign") return skip("volume_alias_foreign");
        if (r !== "created" && r !== "present") return skip("volume_alias_failed");
      }
    }

    // 3. the yardstick of every database-like container, read once before anything changes
    const dbm = members.filter((m) => m.engine && !m.dbBefore);
    if (dbm.length > 0) {
      const fps = await this.fingerprint(serverId, dbm.map((m) => ({ engine: m.engine as DbTarget["engine"], ref: { kind: "recorded" as const, ctr: { id: m.container.id, name: m.container.name, image: m.container.image } } })));
      for (const m of dbm) {
        const fp = fps?.get(m.container.id);
        if (!fp || fp.state !== "ok") return skip("db_verify_failed");
        m.dbBefore = fp;
        m.dbVerify = { level: memberLevel(m), state: "pending" };
      }
    }

    // 4. the compose stack adopted as a deployment, and (when nothing is shared) started next to Coolify's
    if (!item.adoptDeploymentId) {
      try {
        item.adoptDeploymentId = await this.world.createAdoptComposeDeployment(item.appId);
      } catch {
        return skip("adopt_failed");
      }
      await save();
    }
    if (!item.exclusive && !item.afterSwitch) {
      const stop = (): Promise<void> => this.world.stopApp(userId, item.appId).catch(() => undefined);
      const r = await this.world.runAdopted(userId, item.appId, item.adoptDeploymentId);
      if (!r.ok) {
        await stop();
        return skip("prepare_failed");
      }
      const rd = await this.waitReady(serverId, item);
      await save();
      if (!rd.ok) {
        await stop();
        return skip("prepare_failed");
      }
    }
    item.state = "prepared";
    await save();
  }

  /**
   * Wait for every container of Tugra's compose project to be up: running, healthy where it has a health check, and the same on two polls (a
   * container that crash-loops is "running" for an instant). Judged in start order. Marks each member `ok` or `failed`. A container that
   * exited ends the wait at once; otherwise it is waited for up to two minutes.
   */
  private async waitReady(serverId: string, item: TakeoverItem): Promise<{ ok: boolean; notReady: string[] }> {
    const members = item.members ?? [];
    const order = members.map((m) => m.service);
    let prev: MemberProbe[] | null = null;
    let verdict: { ready: boolean; notReady: string[]; dead: string[] } = { ready: false, notReady: order, dead: [] };
    for (let n = 0; n < READY_POLLS; n++) {
      const probes = await this.run(serverId, buildServiceReadyScript(item.project as string), parseServiceReady);
      if (probes) {
        verdict = judgeReady(prev, probes, order);
        prev = probes;
        if (verdict.ready || verdict.dead.length > 0) break;
      }
      await this.world.sleep(READY_POLL_MS);
    }
    for (const m of members) m.ready = verdict.notReady.includes(m.service) ? "failed" : "ok";
    return { ok: verdict.ready, notReady: verdict.notReady };
  }

  /** After the switch: did every database-like container answer the same through Tugra's container as Coolify's did before? Marks each. */
  private async verifyMemberDbs(serverId: string, item: TakeoverItem): Promise<boolean> {
    const dbm = (item.members ?? []).filter((m) => m.engine);
    if (dbm.length === 0) return true;
    const probes = await this.run(serverId, buildServiceReadyScript(item.project as string), parseServiceReady);
    const nameOf = (m: ServiceMemberRecord): string | undefined => probes?.find((p) => p.service === m.service)?.name;
    const targets: DbTarget[] = dbm.flatMap((m) => {
      const name = nameOf(m);
      return name ? [{ engine: m.engine as DbTarget["engine"], ref: { kind: "name" as const, name } }] : [];
    });
    const after = targets.length > 0 ? await this.fingerprint(serverId, targets) : null;
    let ok = true;
    for (const m of dbm) {
      const name = nameOf(m);
      const same = !!name && memberSame(m, after?.get(name));
      m.dbVerify = { level: memberLevel(m), state: same ? "ok" : "failed" };
      if (!same) ok = false;
    }
    return ok;
  }

  /**
   * Start Tugra's copy of an item at the switch (Coolify's containers are stopped). An app starts through its adopted deployment. A service
   * first takes on the network attachments of Coolify's containers (so the names inside it, and the names other containers on Coolify's
   * network use, still resolve), then starts through its compose stack, is waited for member by member and has its databases checked. The
   * failure code, or null.
   */
  private async startItem(userId: string, row: Row, items: TakeoverItem[], serverId: string, item: TakeoverItem): Promise<TakeoverFailureCode | null> {
    if (item.kind !== "service") {
      const r = await this.world.runAdopted(userId, item.appId, item.adoptDeploymentId as string);
      return r.ok ? null : "exclusive_start_failed";
    }
    if (item.networksWanted) {
      // what the app had is recorded BEFORE the change: a crash must still leave the way back
      if (item.networksBefore === undefined) {
        item.networksBefore = (await this.world.service(item.appId))?.networks ?? [];
        await this.saveItems(row.id, items);
      }
      try {
        await this.world.setComposeNetworks(userId, item.appId, item.networksWanted);
      } catch {
        // a refusal that changed nothing leaves nothing to put back (what the app has now is what it had)
        const now = (await this.world.service(item.appId).catch(() => null))?.networks;
        if (now && sameNetworkRows(now, item.networksBefore ?? [])) {
          item.networksBefore = undefined;
          await this.saveItems(row.id, items);
        }
        return "exclusive_start_failed";
      }
    }
    const r = await this.world.runAdopted(userId, item.appId, item.adoptDeploymentId as string);
    if (!r.ok) return "exclusive_start_failed";
    const rd = await this.waitReady(serverId, item);
    await this.saveItems(row.id, items);
    if (!rd.ok) return "service_not_ready";
    const same = await this.verifyMemberDbs(serverId, item);
    await this.saveItems(row.id, items);
    return same ? null : "service_verify_failed";
  }

  /** One look at the containers of every switched service: up and healthy, or not. Never waits, never changes anything. */
  private async checkMembers(serverId: string, items: TakeoverItem[]): Promise<void> {
    for (const i of items) {
      if (i.kind !== "service" || i.state !== "switched" || !i.project) continue;
      const probes = await this.run(serverId, buildServiceReadyScript(i.project), parseServiceReady);
      if (!probes) continue; // a look that could not be made says nothing
      for (const m of i.members ?? []) {
        const p = probes.filter((x) => x.service === m.service);
        m.ready = p.length > 0 && p.every((x) => x.state === "running" && (x.health === "healthy" || x.health === "none")) ? "ok" : "failed";
      }
    }
  }

  /** Read databases through the container's own environment (see {@link buildDbFingerprintScript}). `null` when the host could not be read. */
  private async fingerprint(serverId: string, targets: readonly DbTarget[]): Promise<Map<string, DbFingerprint> | null> {
    const refs = targets.map((t) => (t.ref.kind === "recorded" ? t.ref.ctr.id : t.ref.name));
    return this.run(serverId, buildDbFingerprintScript(targets), (o) => parseDbFingerprint(o, refs));
  }

  /**
   * What Coolify serves now (the yardstick, fetched twice so a page that changes every time is known) and, for the apps that run alongside,
   * what Tugra's proxy answers on its own address. Returns a failure code when a probe could not run at all; a domain that answers wrongly is
   * just `failed`. An app still building is left `pending`.
   */
  private async measure(serverId: string, active: TakeoverItem[]): Promise<TakeoverFailureCode | null> {
    const ready = active.filter((i) => i.state === "prepared");
    const all = [...new Set(ready.flatMap((i) => i.domains.map((d) => d.host)))];
    if (all.length === 0) return null;
    const baseline = await this.probe(serverId, "coolify", all, true);
    if ("fail" in baseline) return "probe_unavailable";
    for (const i of ready) for (const d of i.domains) if (baseline.hosts[d.host]) i.baseline[d.host] = baseline.hosts[d.host];
    const side = ready.filter((i) => !i.exclusive && !i.afterSwitch);
    const hosts = [...new Set(side.flatMap((i) => i.domains.map((d) => d.host)))];
    if (hosts.length === 0) return null;
    const dark = await this.probe(serverId, "tugra-dark", hosts, false);
    if ("fail" in dark) return "probe_unavailable";
    for (const i of side) {
      for (const d of i.domains) d.tempCheck = judgeProbe(i.baseline[d.host], dark.hosts[d.host]).ok ? "ok" : "failed";
    }
    return null;
  }

  // ───────────────────────────── swap ─────────────────────────────

  /**
   * Take the ports. Only after a passed test and the owner's typed server name. Apps that share data with Coolify's copy are switched first
   * (Coolify's container stopped, Tugra's started on the same volume); Coolify's certificates are put in place as the fallback; Coolify's
   * proxy is stopped and Tugra's published on :80/:443; then every domain is checked again. A failure before the ports change reverses
   * the switch by itself and ends FAILED; a failed domain check afterwards is shown and the owner decides (give back is one click).
   */
  async swap(userId: string, id: string, input: SwapInput): Promise<TakeoverView> {
    return this.exclusive(id, async () => {
      const { row, server } = await this.acting(userId, id);
      if (row.status !== "TESTING") throw new ConflictException("takeover_not_tested");
      if (input.confirm !== server.name) throw new BadRequestException("bad-confirmation");
      return this.doSwap(userId, row, server);
    });
  }

  private async doSwap(userId: string, row: Row, server: { id: string; name: string }): Promise<TakeoverView> {
    const items = this.itemsOf(row);
    const gate = swapGate(items);
    if (!gate.ok) throw new ConflictException({ statusCode: 409, message: `takeover_${gate.code}`, code: `takeover_${gate.code}`, ...(gate.itemRef ? { itemRef: gate.itemRef } : {}), ...(gate.host ? { host: gate.host } : {}) });
    const plan = this.planOf(row);
    const rb = this.rollbackOf(row);
    await this.setStatus(row, "SWAPPING", null);
    const active = items.filter((i) => i.state === "prepared");
    const ex = active.filter((i) => i.exclusive && hasCtrs(i));

    // 1. apps that share data with Coolify's copy: its restart policy first, then stop it, then start Tugra's on the same data. The apps that
    // write to a switched database go quiet FIRST, and the yardstick of each database is read again once they are quiet and before the
    // database itself stops: what the test read days ago is stale (the apps kept writing, the owner took time to approve). A service is
    // switched as a whole: its containers stop dependents first and its database-like containers last, and start through the compose app.
    if (ex.length > 0) {
      const dbs = ex.filter((i) => i.kind === "database");
      const svcs = ex.filter((i) => i.kind === "service");
      const quiet = active.filter((i) => i.afterSwitch && !i.exclusive && hasCtrs(i));
      const first = [...ex.filter((i) => i.kind !== "database" && i.kind !== "service").flatMap((i) => stopCtrs(i)), ...quiet.flatMap((i) => stopCtrs(i)), ...svcs.flatMap((i) => stopCtrs(i, "rest"))];
      const last = [...dbs.flatMap((i) => stopCtrs(i)), ...svcs.flatMap((i) => stopCtrs(i, "db"))];
      // written BEFORE the first policy change: a partial failure below must still give every recorded policy back
      rb.exclusiveStopped = true;
      await this.saveRollback(row.id, rb);
      const halt = async (list: ReturnType<typeof stopCtrs>, policyCode: TakeoverFailureCode, stopCode: TakeoverFailureCode): Promise<TakeoverFailureCode | null> => {
        if (list.length === 0) return null;
        const ids = list.map((c) => c.id);
        const pol = parsePolicy((await this.world.exec(server.id, buildRestartPolicyScript(list.map((c) => ({ id: c.id, name: c.name, image: c.image, policy: "no" as const }))), HOST_T)).output, ids);
        if (ids.some((x) => pol.get(x) !== "ok")) return policyCode;
        const stop = parseStopOutput((await this.world.exec(server.id, buildSourceStopScript(list), 150_000)).output, ids);
        if (ids.some((x) => stop.get(x) !== "stopped" && stop.get(x) !== "gone")) return stopCode;
        return null;
      };
      const quietFail = await halt(first, "exclusive_policy_failed", "exclusive_stop_failed");
      if (quietFail) return this.abandon(userId, row, items, quietFail);
      const svcDbs = svcs.flatMap((i) => (i.members ?? []).filter((m) => m.engine).map((m) => ({ i, m })));
      if (dbs.length > 0 || svcDbs.length > 0) {
        const fresh = await this.fingerprint(server.id, [
          ...dbs.map((i) => ({ engine: i.engine as DbTarget["engine"], ref: { kind: "recorded" as const, ctr: recorded(i) } })),
          ...svcDbs.map(({ m }) => ({ engine: m.engine as DbTarget["engine"], ref: { kind: "recorded" as const, ctr: { id: m.container.id, name: m.container.name, image: m.container.image } } })),
        ]);
        for (const i of dbs) {
          const fp = fresh?.get((i.container as NonNullable<TakeoverItem["container"]>).id);
          if (!fp || fp.state !== "ok") {
            i.verify = { level: i.verify?.level ?? checkLevelOf(i.engine as DbTarget["engine"]), state: "failed" };
            await this.saveItems(row.id, items);
            return this.abandon(userId, row, items, "database_verify_failed");
          }
          i.dbBefore = fp;
        }
        for (const { m } of svcDbs) {
          const fp = fresh?.get(m.container.id);
          if (!fp || fp.state !== "ok") {
            m.dbVerify = { level: memberLevel(m), state: "failed" };
            await this.saveItems(row.id, items);
            return this.abandon(userId, row, items, "service_verify_failed");
          }
          m.dbBefore = fp;
        }
        await this.saveItems(row.id, items);
      }
      const dbFail = await halt(last, "exclusive_policy_failed", "exclusive_stop_failed");
      if (dbFail) return this.abandon(userId, row, items, dbFail);
      // databases first (what the apps need), each checked against what Coolify's container showed; then the apps and services that share data
      for (const i of dbs) {
        const r = await this.world.runDatabase(userId, i.appId);
        if (!r.ok) return this.abandon(userId, row, items, "database_start_failed");
      }
      if (dbs.length > 0) {
        const targets: DbTarget[] = dbs.map((i) => ({ engine: i.engine as DbTarget["engine"], ref: { kind: "name", name: dbContainerName({ id: i.appId }) } }));
        const after = await this.fingerprint(server.id, targets);
        let bad = false;
        for (const i of dbs) {
          const ok = sameDatabase(i.dbBefore, after?.get(dbContainerName({ id: i.appId })));
          i.verify = { level: i.verify?.level ?? checkLevelOf(i.engine as DbTarget["engine"]), state: ok ? "ok" : "failed" };
          if (!ok) bad = true;
        }
        await this.saveItems(row.id, items);
        if (bad) return this.abandon(userId, row, items, "database_verify_failed");
      }
      for (const i of ex.filter((x) => x.kind !== "database")) {
        const code = await this.startItem(userId, row, items, server.id, i);
        if (code) return this.abandon(userId, row, items, code);
      }
    }
    // apps and services that talk to a switched database run once it does
    for (const i of active.filter((x) => x.afterSwitch && !x.exclusive)) {
      const code = await this.startItem(userId, row, items, server.id, i);
      if (code) return this.abandon(userId, row, items, code);
    }

    // 2. Coolify's certificates as the fallback, before Tugra's proxy takes the ports
    const hosts = domainsOf(active).map((d) => d.host);
    const fb = await this.run(server.id, buildFallbackInstallScript({ hosts }), (o) => parseFallbackInstall(o, hosts));
    const now = this.world.now().toISOString();
    for (const i of active) {
      for (const d of i.domains) {
        const r = fb?.get(d.host);
        if (r?.outcome === "installed") {
          i.fallbackSerial[d.host] = r.serial;
          i.fallbackAt[d.host] = now;
          (i.fallbackSince ??= {})[d.host] ??= now;
          d.cert = "fallback";
        }
      }
    }
    await this.saveItems(row.id, items);

    // 3. the proxies: Coolify's stops (restart policy first), Tugra's publishes :80/:443
    rb.swapStarted = true;
    await this.saveRollback(row.id, rb);
    const stopped = await stopSourceProxy(this.host, server.id, plan.proxy.containerId);
    if (!stopped || stopped.updateFailed || stopped.sourceRunning === true) return this.abandon(userId, row, items, "swap_stop_failed");
    await this.world.setProxyBind(server.id, "public");
    try {
      await this.world.startProxy(userId, server.id);
    } catch {
      // the state read below decides: a start that failed is judged by what the box looks like, not by the error
    }
    const st = await swapHostState(this.host, server.id, plan.proxy.containerId);
    if (!st || st.target !== "running" || !targetPublishesWeb(st) || st.sourceRunning === true) return this.abandon(userId, row, items, "swap_start_failed");

    for (const i of active) i.state = "switched";
    await this.saveItems(row.id, items);
    await this.setStatus(row, "SWAPPED", null);
    await this.checkFinal(server.id, items);
    await this.saveItems(row.id, items);
    await this.audit.log({ actor: userId, action: "coolify.takeover.swap", target: row.id, meta: { apps: active.length, switched: ex.length, domains: hosts.length, fallbacks: items.flatMap((i) => i.domains).filter((d) => d.cert === "fallback").length, ...(row.runId ? { runId: row.runId } : {}) } });
    return this.fresh(row.id);
  }

  /** Reverse what the swap did so far (the same way a give-back does) and end FAILED with the reason. */
  private async abandon(userId: string, row: Row, items: TakeoverItem[], code: TakeoverFailureCode): Promise<TakeoverView> {
    const r = await this.undo(userId, row.id, items);
    await this.saveItems(row.id, items);
    await this.prisma.coolifyTakeover.update({ where: { id: row.id }, data: { status: "FAILED", failureCode: r.ok ? code : "give_back_failed" } });
    await this.audit.log({ actor: userId, action: "coolify.takeover.swap", target: row.id, meta: { failure: code, reversed: r.ok } });
    return this.fresh(row.id);
  }

  /** Every domain through the proxy that now owns the box, against what Coolify answered before. */
  private async checkFinal(serverId: string, items: TakeoverItem[]): Promise<void> {
    const active = items.filter((i) => i.state === "switched");
    const hosts = [...new Set(active.flatMap((i) => i.domains.map((d) => d.host)))];
    if (hosts.length === 0) return;
    const res = await this.probe(serverId, "local", hosts, false);
    for (const i of active) {
      for (const d of i.domains) {
        if ("fail" in res) d.finalCheck = "failed";
        else d.finalCheck = judgeProbe(i.baseline[d.host], res.hosts[d.host]).ok ? "ok" : "failed";
      }
    }
  }

  // ───────────────────────────── verify (re-check and new certificates) ─────────────────────────────

  /**
   * Check every domain again and work on the certificates, a few domains per call. For a domain on Coolify's fallback certificate, the
   * fallback is taken away and the hub waits for a NEW Let's Encrypt certificate to be served; if it does not come in time the fallback is put
   * back and the domain stays marked failed (and is tried again on the next call, up to a few attempts). Oldest fallback first, so none is
   * served much past the short window.
   */
  async verify(userId: string, id: string): Promise<TakeoverView> {
    return this.exclusive(id, () => this.verifyPass(userId, id, false));
  }

  /**
   * The same pass on a timer, for every takeover still on Coolify's fallback certificates (the owner said "a few minutes at most", so the hub
   * does not wait to be asked). Acts as the owner who planned the takeover and skips it if that person is no longer an owner of the team;
   * every pass is audited with `auto`. A takeover another call is working on is left to that call. Returns how many were worked on.
   */
  async sweepFallbacks(): Promise<number> {
    const rows = (await this.prisma.coolifyTakeover.findMany({ where: { status: "SWAPPED" } })) as Row[];
    let done = 0;
    for (const row of rows) {
      if (row.status !== "SWAPPED" || this.active.has(row.id)) continue;
      const items = this.itemsOf(row);
      // nothing left that a pass could change (attempts used and the failure already shown): leave it to the owner
      if (!certWorkLeft(items) && row.failureCode) continue;
      try {
        await this.exclusive(row.id, () => this.verifyPass(row.actorId, row.id, true));
        done += 1;
      } catch {
        // not an owner any more, agent offline or the takeover moved on: the next tick looks again
      }
    }
    return done;
  }

  private async verifyPass(userId: string, id: string, auto: boolean): Promise<TakeoverView> {
    const { row, server } = await this.acting(userId, id);
    if (row.status !== "SWAPPED" && row.status !== "VERIFIED") throw new ConflictException("takeover_not_swapped");
    const items = this.itemsOf(row);
    await this.checkFinal(server.id, items);
    await this.checkMembers(server.id, items);
    const queue = items
      .filter((i) => i.state === "switched")
      .flatMap((i) => i.domains.filter((d) => d.cert !== "issued" && d.finalCheck === "ok" && (i.certAttempts[d.host] ?? 0) < CERT_MAX_ATTEMPTS).map((d) => ({ i, d })))
      .sort((a, b) => ((a.i.fallbackAt[a.d.host] ?? "9") < (b.i.fallbackAt[b.d.host] ?? "9") ? -1 : 1))
      .slice(0, CERT_BATCH);
    let blind = row.failureCode === "cert_check_unavailable";
    for (const { i, d } of queue) if ((await this.renew(server.id, i, d)) === "noopenssl") blind = true;
    await this.saveItems(row.id, items);
    const verified = isVerified(items);
    // a check the box cannot make, or Coolify's certificate still served past the limit, is a failure the owner sees, never a quiet stop
    const svcBad = items.some((i) => i.kind === "service" && i.state === "switched" && (i.members ?? []).some((m) => m.ready === "failed"));
    const failure: TakeoverFailureCode | null = verified ? null : svcBad ? "service_not_ready" : blind ? "cert_check_unavailable" : overdueFallbacks(items, this.world.now()).length > 0 ? "fallback_overdue" : null;
    await this.setStatus(row, verified ? "VERIFIED" : "SWAPPED", failure);
    const all = items.flatMap((i) => i.domains);
    await this.audit.log({
      actor: userId,
      action: "coolify.takeover.verify",
      target: row.id,
      meta: {
        domains: all.length,
        issued: all.filter((d) => d.cert === "issued").length,
        fallback: all.filter((d) => d.cert === "fallback").length,
        failed: all.filter((d) => d.cert === "failed").length,
        checkFailed: all.filter((d) => d.finalCheck === "failed").length,
        ...(failure ? { failure } : {}),
        ...(auto ? { auto: true } : {}),
      },
    });
    return this.fresh(row.id);
  }

  /** One domain: is a new certificate already served? If not, take the fallback away and wait for one; put the fallback back when none comes. */
  private async renew(serverId: string, item: TakeoverItem, d: TakeoverItem["domains"][number]): Promise<"noopenssl" | void> {
    const fbSerial = item.fallbackSerial[d.host] ?? null;
    const check = () => this.run(serverId, buildNewCertCheckScript(d.host), (o) => parseNewCertCheck(o, d.host));
    const removeFallback = () => this.run(serverId, buildFallbackRemoveScript([d.host]), (o) => (o.includes("TUGRA_IP_FALLBACK_REMOVED") ? true : null));
    const served = await check();
    if (served && isNewLetsEncryptCert(served, fbSerial)) {
      await removeFallback();
      d.cert = "issued";
      return;
    }
    if (served?.state === "noopenssl") {
      // the box cannot tell a new certificate from the old one: nothing to wait for, nothing to retry. It is a failed check, shown as one
      item.certAttempts[d.host] = CERT_MAX_ATTEMPTS;
      d.cert = "failed" satisfies TakeoverCertState;
      return "noopenssl";
    }
    // take the fallback away so the proxy asks for a new certificate, and wait for it
    await removeFallback();
    for (let n = 0; n < CERT_POLLS; n++) {
      await this.world.sleep(CERT_POLL_MS);
      const s = await check();
      if (s && isNewLetsEncryptCert(s, fbSerial)) {
        d.cert = "issued";
        return;
      }
    }
    // no new certificate in time: Coolify's goes back so the domain keeps a valid one, and the failure stays visible
    item.certAttempts[d.host] = (item.certAttempts[d.host] ?? 0) + 1;
    const back = await this.run(serverId, buildFallbackInstallScript({ hosts: [d.host] }), (o) => parseFallbackInstall(o, [d.host]));
    const r = back?.get(d.host);
    if (r?.outcome === "installed") {
      item.fallbackSerial[d.host] = r.serial;
      item.fallbackAt[d.host] = this.world.now().toISOString();
    }
    d.cert = "failed" satisfies TakeoverCertState;
  }

  // ───────────────────────────── give back ─────────────────────────────

  /**
   * One click back to Coolify: Tugra's copies stop, Coolify's containers that were switched start again with their recorded restart policy,
   * Tugra's proxy stops and Coolify's proxy starts, the fallback certificates go, the proxy setting returns to what it was. Idempotent: if a
   * step fails the takeover is FAILED and pressing it again continues. Nothing of Coolify's was ever removed, so there is nothing to restore from.
   */
  async giveBack(userId: string, id: string, input: GiveBackInput): Promise<TakeoverView> {
    return this.exclusive(id, async () => {
      const { row, server } = await this.acting(userId, id);
      if (!canGiveBack(row.status as TakeoverStatus)) throw new ConflictException("takeover_not_giveable");
      if (input.confirm !== server.name) throw new BadRequestException("bad-confirmation");
      return this.doGiveBack(userId, row);
    });
  }

  private async doGiveBack(userId: string, row: Row): Promise<TakeoverView> {
    const items = this.itemsOf(row);
    await this.prisma.coolifyTakeover.update({ where: { id: row.id }, data: { status: "GIVING_BACK", failureCode: null } });
    const r = await this.undo(userId, row.id, items);
    await this.saveItems(row.id, items);
    if (!r.ok) {
      await this.prisma.coolifyTakeover.update({ where: { id: row.id }, data: { status: "FAILED", failureCode: "give_back_failed" } });
      await this.audit.log({ actor: userId, action: "coolify.takeover.give-back", target: row.id, meta: { ok: false, step: r.step } });
      return this.fresh(row.id);
    }
    await this.prisma.coolifyTakeover.update({ where: { id: row.id }, data: { status: "GIVEN_BACK", giveBackAvailable: false, finishedAt: this.world.now(), failureCode: null } });
    await this.audit.log({ actor: userId, action: "coolify.takeover.give-back", target: row.id, meta: { ok: true, apps: items.filter((i) => i.state !== "skipped").length, ...(row.runId ? { runId: row.runId } : {}) } });
    return this.fresh(row.id);
  }

  /**
   * Reverse everything done to the box, in the order that keeps each app reachable: the apps that were switched get Coolify's container back
   * first, then the proxies, then the fallback certificates and Tugra's side-by-side copies. Every step tolerates having been done already.
   */
  private async undo(userId: string, rowId: string, items: TakeoverItem[]): Promise<{ ok: true } | { ok: false; step: string }> {
    const row = await this.rowOf(rowId);
    const plan = this.planOf(row);
    const rb = this.rollbackOf(row);
    const serverId = row.serverId;
    try {
      // 1. switched apps and services: Tugra's copy stops (frees the data), Coolify's containers get their policy back and start (databases
      // first, a service's containers dependencies first)
      const ex = items.filter((i) => (i.exclusive || i.afterSwitch) && hasCtrs(i) && i.state !== "skipped");
      if (rb.exclusiveStopped && ex.length > 0) {
        for (const i of ex.filter((x) => x.exclusive)) await (i.kind === "database" ? this.world.stopDatabase(userId, i.appId) : this.world.stopApp(userId, i.appId));
        // the compose apps' network attachments go back to what they were (the takeover added Coolify's)
        for (const i of ex.filter((x) => x.kind === "service" && x.networksBefore !== undefined)) {
          const now = (await this.world.service(i.appId).catch(() => null))?.networks;
          if (!now || !sameNetworkRows(now, i.networksBefore ?? [])) await this.world.setComposeNetworks(userId, i.appId, i.networksBefore ?? []);
          i.networksBefore = undefined;
          await this.saveItems(rowId, items);
        }
        const list = [...ex.filter((i) => i.kind === "database"), ...ex.filter((i) => i.kind !== "database")].flatMap((i) => ctrsOf(i));
        const ids = list.map((c) => c.id);
        const pol = parsePolicy((await this.world.exec(serverId, buildRestartPolicyScript(list.map((c) => ({ id: c.id, name: c.name, image: c.image, policy: c.restart }))), HOST_T)).output, ids);
        if (ids.some((x) => pol.get(x) !== "ok")) return { ok: false, step: "coolify_policy" };
        const start = parseStartOutput((await this.world.exec(serverId, buildSourceStartScript(list), HOST_T)).output, ids);
        if (ids.some((x) => start.get(x) !== "started")) return { ok: false, step: "coolify_containers" };
        rb.exclusiveStopped = false;
        await this.saveRollback(rowId, rb);
      }
      // 2. proxies
      if (rb.swapStarted) {
        const st = await reverseSwapOnHost(this.host, serverId, { containerId: plan.proxy.containerId, restartPolicy: plan.proxy.restartPolicy });
        if (!st || st.sourceRunning !== true) return { ok: false, step: "coolify_proxy" };
        rb.swapStarted = false;
        await this.saveRollback(rowId, rb);
      } else if (rb.darkStarted && rb.proxyBefore !== "running") {
        await this.world.exec(serverId, buildProxyStopScript(), HOST_T);
      }
      if (rb.darkStarted) {
        await this.world.setProxyBind(serverId, rb.bindBefore === "loopback" || rb.bindBefore === "public" ? rb.bindBefore : "none");
        if (rb.proxyBefore === "running") await this.world.startProxy(userId, serverId);
        rb.darkStarted = false;
        await this.saveRollback(rowId, rb);
      }
      // 3. fallback certificates (the files this lane wrote, by name)
      const hosts = items.filter((i) => i.state !== "skipped").flatMap((i) => i.domains.filter((d) => d.cert !== "pending" || i.fallbackAt[d.host]).map((d) => d.host));
      if (hosts.length > 0) await this.world.exec(serverId, buildFallbackRemoveScript(hosts), HOST_T);
      // 4. Tugra's copies that ran alongside
      for (const i of items) {
        if (i.state === "skipped" || i.exclusive) continue;
        if (i.adoptDeploymentId || i.rebuildDeploymentId) await this.world.stopApp(userId, i.appId);
      }
      for (const i of items) {
        if (i.state === "skipped") continue;
        i.state = "given-back";
        for (const m of i.members ?? []) {
          m.ready = "pending";
          if (m.dbVerify) m.dbVerify = { level: m.dbVerify.level, state: "pending" };
        }
        for (const d of i.domains) {
          d.cert = "pending";
          d.finalCheck = "pending";
        }
      }
      return { ok: true };
    } catch {
      return { ok: false, step: "host" };
    }
  }

  // ───────────────────────────── the guided run's port ─────────────────────────────

  async runState(userId: string, runId: string): Promise<RunTakeoverState | null> {
    const row = await this.rowOfRun(runId);
    if (!row) return null;
    await this.requireOwner(userId, row.teamId);
    return this.stateOf(row);
  }

  async runPrepare(userId: string, input: { runId: string; serverId: string; opId: string }): Promise<RunTakeoverState> {
    let row = await this.rowOfRun(input.runId);
    // a reversed takeover (given back, or one the swap itself put back) is never tested again: the run plans a new one
    const spent = !row || row.status === "GIVEN_BACK" || (row.status === "FAILED" && this.itemsOf(row).some((i) => i.state === "given-back"));
    if (spent) {
      const v = await this.plan(userId, { serverId: input.serverId, opId: input.opId, rebuild: [] }, { runId: input.runId });
      row = await this.rowOf(v.id);
    }
    const r = row as Row;
    if (r.status === "PLANNED" || r.status === "TESTING" || r.status === "FAILED") await this.test(userId, r.id);
    return this.stateOf(await this.rowOf(r.id));
  }

  async runSwap(userId: string, runId: string): Promise<RunTakeoverState> {
    const row = await this.requireRunRow(runId);
    return this.exclusive(row.id, async () => {
      const { row: r, server } = await this.acting(userId, row.id);
      if (r.status !== "TESTING") throw new ConflictException("takeover_not_tested");
      await this.doSwap(userId, r, server);
      return this.stateOf(await this.rowOf(row.id));
    });
  }

  async runVerify(userId: string, runId: string): Promise<RunTakeoverState> {
    const row = await this.requireRunRow(runId);
    await this.exclusive(row.id, () => this.verifyPass(userId, row.id, false));
    return this.stateOf(await this.rowOf(row.id));
  }

  async runGiveBack(userId: string, runId: string): Promise<RunTakeoverState | null> {
    const row = await this.rowOfRun(runId);
    if (!row) return null;
    await this.exclusive(row.id, async () => {
      const { row: r } = await this.acting(userId, row.id);
      if (!canGiveBack(r.status as TakeoverStatus)) return;
      await this.doGiveBack(userId, r);
    });
    return this.stateOf(await this.rowOf(row.id));
  }

  /** The newest takeover the run carries. */
  private async rowOfRun(runId: string): Promise<Row | null> {
    return ((await this.prisma.coolifyTakeover.findFirst({ where: { runId }, orderBy: { createdAt: "desc" } })) as Row | null) ?? null;
  }

  private async requireRunRow(runId: string): Promise<Row> {
    const row = await this.rowOfRun(runId);
    if (!row) throw new NotFoundException("takeover-not-found");
    return row;
  }

  private stateOf(row: Row): RunTakeoverState {
    const items = this.itemsOf(row);
    const active = items.filter((i) => i.state !== "skipped");
    return {
      id: row.id,
      status: row.status as TakeoverStatus,
      failureCode: (row.failureCode as TakeoverFailureCode | null) ?? null,
      items: items.map(toItemView),
      gate: swapGate(items),
      pending: active.filter((i) => i.state === "planned").length,
      certWorkLeft: certWorkLeft(items),
      verified: isVerified(items),
      proxy: this.planOf(row).proxy,
      bindBefore: this.rollbackOf(row).bindBefore,
    };
  }

  // ───────────────────────────── reads ─────────────────────────────

  async get(userId: string, id: string): Promise<TakeoverView> {
    const row = await this.rowOf(id);
    await this.requireMember(userId, row.teamId);
    return this.view(row);
  }

  async list(userId: string, serverId: string): Promise<TakeoverView[]> {
    const server = await this.world.server(serverId);
    if (!server) throw new NotFoundException("server-not-found");
    await this.requireMember(userId, server.teamId);
    const rows = await this.prisma.coolifyTakeover.findMany({ where: { serverId }, orderBy: { createdAt: "desc" }, take: 20 });
    return rows.map((r) => this.view(r as Row));
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private get host(): { exec: InPlaceWorld["exec"] } {
    return { exec: (s, c, t) => this.world.exec(s, c, t) };
  }

  /** Run a script and parse it; any failure to run or parse is `null`, never a pass. */
  private async run<T>(serverId: string, script: string, parse: (out: string) => T | null): Promise<T | null> {
    try {
      const r = await this.world.exec(serverId, script, HOST_T);
      return parse(r.output);
    } catch {
      return null;
    }
  }

  private async probe(serverId: string, via: ProbeVia, hosts: readonly string[], twice: boolean): Promise<{ hosts: Record<string, ProbeResult> } | { fail: "noproxy" | "nocurl" | "unreadable" }> {
    const out: Record<string, ProbeResult> = {};
    for (let n = 0; n < hosts.length; n += PROBE_CHUNK) {
      const chunk = hosts.slice(n, n + PROBE_CHUNK);
      let parsed: ReturnType<typeof parseInPlaceProbe> = null;
      try {
        const r = await this.world.exec(serverId, buildInPlaceProbeScript({ via, hosts: chunk, path: "/", twice }), probeTimeout(chunk.length));
        parsed = parseInPlaceProbe(r.output, chunk);
      } catch {
        parsed = null;
      }
      if (!parsed) return { fail: "unreadable" };
      if (parsed.kind !== "ok") return { fail: parsed.kind };
      Object.assign(out, parsed.hosts);
    }
    return { hosts: out };
  }

  /** One action at a time per takeover (a second press while one runs is a 409, never a second run). */
  private async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.active.has(id)) throw new ConflictException("takeover_busy");
    this.active.add(id);
    try {
      return await fn();
    } finally {
      this.active.delete(id);
    }
  }

  private async acting(userId: string, id: string): Promise<{ row: Row; server: NonNullable<Awaited<ReturnType<InPlaceWorld["server"]>>> }> {
    const row = await this.rowOf(id);
    await this.requireOwner(userId, row.teamId);
    const server = await this.world.server(row.serverId);
    if (!server) throw new NotFoundException("server-not-found");
    if (server.status !== "ONLINE") throw unprocessable("takeover_server_offline");
    return { row, server };
  }

  private async requireOwner(userId: string, teamId: string): Promise<void> {
    const role = await this.access.teamRole(userId, teamId);
    if (!role) throw new NotFoundException("takeover-not-found"); // not a member: indistinguishable from unknown
    if (!OWNER_ONLY.includes(role)) throw new ForbiddenException("insufficient role for this team");
  }

  private async requireMember(userId: string, teamId: string): Promise<void> {
    const role = await this.access.teamRole(userId, teamId);
    if (role !== Role.OWNER && role !== Role.ADMIN) throw new NotFoundException("takeover-not-found");
  }

  private requireTransition(from: string, to: TakeoverStatus): void {
    if (!canTakeoverTransition(from as TakeoverStatus, to)) throw new ConflictException(`takeover_cannot_${to.toLowerCase()}`);
  }

  private async rowOf(id: string): Promise<Row> {
    const row = await this.prisma.coolifyTakeover.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("takeover-not-found");
    return row as Row;
  }

  private async fresh(id: string): Promise<TakeoverView> {
    return this.view(await this.rowOf(id));
  }

  private async setStatus(row: Row, status: TakeoverStatus, failureCode: string | null): Promise<void> {
    await this.prisma.coolifyTakeover.update({ where: { id: row.id }, data: { status, failureCode } });
    row.status = status;
  }

  private saveItems(id: string, items: TakeoverItem[]): Promise<unknown> {
    return this.prisma.coolifyTakeover.update({ where: { id }, data: { items: items as unknown as Prisma.InputJsonValue } });
  }

  private saveRollback(id: string, rb: Rollback): Promise<unknown> {
    return this.prisma.coolifyTakeover.update({ where: { id }, data: { rollback: rb as unknown as Prisma.InputJsonValue } });
  }

  private itemsOf(row: Row): TakeoverItem[] {
    return Array.isArray(row.items) ? (JSON.parse(JSON.stringify(row.items)) as TakeoverItem[]) : [];
  }
  private planOf(row: Row): PlanDoc {
    return row.plan as unknown as PlanDoc;
  }
  private rollbackOf(row: Row): Rollback {
    return { ...emptyRollback(), ...((row.rollback ?? {}) as Partial<Rollback>) };
  }

  private view(row: Row): TakeoverView {
    return {
      id: row.id,
      serverId: row.serverId,
      status: row.status as TakeoverStatus,
      tempPort: row.tempPort,
      items: this.itemsOf(row).map(toItemView),
      giveBackAvailable: row.giveBackAvailable,
      failureCode: (row.failureCode as TakeoverFailureCode | null) ?? null,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }
}

/** From the swap on, Tugra's proxy may own the ports: a test is no longer allowed (only a give-back undoes it). */
function portsOwnedByTugra(row: Row): boolean {
  return row.status === "SWAPPING" || row.status === "SWAPPED" || row.status === "VERIFIED";
}
