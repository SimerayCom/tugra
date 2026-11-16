import { DnsAutomationService } from "../../../../dns/dns-automation.service";
import { fakeCloudflare, fakeCutoverPrisma, type ZoneRec } from "../../../../cutover/cutover.fakes";
import { CutoverService } from "../../../../cutover/cutover.service";
import { StepHandlerRegistryService } from "../../../core/step-handler.registry";
import type { StepKey } from "../../../core/run-contract";
import { RunOptionsSchema, type RunOptions } from "../../../core/dto";
import { CutoverHandler } from "../cutover.handler";
import { CutoverPlanService } from "../cutover-plan.service";
import type { CutoverWorld, GitWebhookApp, OpApp, ServerFacts, SwapRow } from "../cutover-world.service";
import type { ObjectsVerification } from "../cutover-holds";
import { DecommissionHandler } from "../decommission.handler";
import { DnsPrepareHandler } from "../dns-prepare.handler";
import { FinalizeHandler } from "../finalize.handler";
import { ObserveHandler } from "../observe.handler";
import { buildSwapInspectScript, type CoolifyProxySnapshot, type SwapState } from "../proxy-swap";
import { TlsPreissueHandler } from "../tls-preissue.handler";
import type { SourceContainer } from "../decommission-script";
import { Crash, StepDriver, makeRun } from "./step-driver";

export const OP = "op1";
export const U = "user1";
export const SRV = "srv1";
export const IP = "203.0.113.7";
export const OLD = "198.51.100.1";
export const COOLIFY_ID = "c".repeat(64);
export const H = (i: number) => `h${i}.example.com`;
const rec = (id: string, host: string, content = OLD, over: Partial<ZoneRec> = {}): ZoneRec => ({ id, type: "A", name: host, content, ttl: 3600, proxied: false, ...over });

/** What the docker box answers (only the things the swap/decommission scripts read). */
export class SimHost {
  coolify: { id: string; name: string; image: string; restart: string; running: boolean; ports: string[] } | null = {
    id: COOLIFY_ID, name: "/coolify-proxy", image: "traefik:v3.1", restart: "always", running: true, ports: ["80>80/tcp", "443>443/tcp", "8080>8080/tcp"],
  };
  tugra: { status: string; ports: string[] } = { status: "absent", ports: [] };
  /** The Coolify control plane runs on this box (a container named `coolify`). */
  controlPlane = false;
  updateFails = false;
  /** Coolify brings its own proxy back as soon as it is stopped (lab item T1). */
  coolifyAutoRestarts = false;
  /** Coolify brings its proxy back between the stop and Tugra's proxy start (it then owns :80/:443 again). */
  coolifyComesBack = false;
  /** Tugra's proxy start fails (like `docker run -p 80:80` does: port already allocated) while Coolify's proxy holds :80/:443. */
  startFailsOnPortConflict = false;
  /** dark probe answers per host: verify 0 = valid cert. */
  dark = new Map<string, { verify: number | null; status: number; traefik404: boolean }>();
  loopback = new Map<string, number>();
  sourceContainers: SourceContainer[] = [];
  /** What the decommission discovery says about the control plane on this box; `null` = no such line (an older script). */
  cpMarker: boolean | null = false;
  log: Array<{ kind: string; ponr: boolean }> = [];
  failNext: string | null = null;
  onCommand: (kind: string) => void = () => undefined;

  private note(kind: string) {
    this.log.push({ kind, ponr: false });
    this.onCommand(kind);
  }

  exec(script: string): { exitCode: number; output: string } {
    const ok = (output: string) => ({ exitCode: 0, output });
    if (script === buildSwapInspectScript()) {
      this.note("swap-inspect");
      const c = this.coolify;
      if (!c) return ok("TUGRA_SWAP_ABSENT\n");
      return ok([`TUGRA_SWAP_ID=${c.id}`, `TUGRA_SWAP_NAME=${c.name}`, `TUGRA_SWAP_IMAGE=${c.image}`, `TUGRA_SWAP_RESTART=${c.restart}`, `TUGRA_SWAP_RUNNING=${c.running}`, `TUGRA_SWAP_PORTS=${c.ports.map((p) => `${p.split(">")[0]}>${p.split(">")[1]},`).join("")}`, `TUGRA_SWAP_CONTROL_PLANE=${this.controlPlane ? "ghcr.io/coollabsio/coolify:4.1.2" : ""}`, "TUGRA_SWAP_END"].join("\n"));
    }
    if (script.includes("docker stop tugra-proxy")) {
      this.note("swap-reverse");
      const policy = /--restart=([a-z-]+) /.exec(script)?.[1] ?? "no";
      const c = this.coolify!;
      this.tugra = { status: "exited", ports: [] };
      c.restart = policy;
      c.running = true;
      return ok(`TUGRA_SWAP_SOURCE_RUNNING=${c.running}\nTUGRA_SWAP_TARGET=${this.tugra.status}\n`);
    }
    if (script.includes("docker update --restart=no")) {
      this.note("swap-stop-source");
      const c = this.coolify;
      if (this.updateFails || !c) return ok("TUGRA_SWAP_UPDATE_FAILED\n");
      c.restart = "no";
      c.running = false;
      if (this.coolifyAutoRestarts) c.running = true;
      return ok(`TUGRA_SWAP_SOURCE_RUNNING=${c.running}\n`);
    }
    if (script.includes("TUGRA_SWAP_STATUS_END")) {
      this.note("swap-status");
      const c = this.coolify;
      return ok([`TUGRA_SWAP_SOURCE_RUNNING=${c ? c.running : "absent"}`, `TUGRA_SWAP_TARGET=${this.tugra.status}`, `TUGRA_SWAP_TARGET_PORTS=${this.tugra.ports.map((p) => `${p},`).join("")}`, "TUGRA_SWAP_STATUS_END"].join("\n"));
    }
    if (script.includes("TUGRA_DARK_PROBE_END")) {
      this.note("dark-probe");
      if (this.tugra.status !== "running") return ok("TUGRA_DARK_PROBE_NOPROXY\n");
      const hosts = [...script.matchAll(/for H in ([^;]+); do/g)][0][1].split(" ").map((h) => h.replace(/'/g, ""));
      const lines = hosts.map((h) => {
        const r = this.dark.get(h);
        return r ? `TUGRA_DARK_PROBE host=${h} verify=${r.verify === null ? "x" : r.verify} status=${String(r.status).padStart(3, "0")} traefik404=${r.traefik404 ? 1 : 0}` : `TUGRA_DARK_PROBE host=${h} verify=x status=000 traefik404=0`;
      });
      return ok([...lines, "TUGRA_DARK_PROBE_END"].join("\n"));
    }
    if (script.includes("TUGRA_CUTOVER_PROBE")) {
      this.note("loopback-probe");
      const h = /H='([^']+)'/.exec(script)![1];
      return ok(`TUGRA_CUTOVER_PROBE status=${String(this.loopback.get(h) ?? 200).padStart(3, "0")}\n`);
    }
    if (script.includes("TUGRA_SRC_END")) {
      this.note("decommission-discover");
      return ok([...(this.cpMarker === null ? [] : [`TUGRA_SRC_CP ${this.cpMarker ? "yes" : "no"}`]), ...this.sourceContainers.map((c) => `TUGRA_SRC id=${c.id} name=${c.name} running=${c.running}`), "TUGRA_SRC_END"].join("\n"));
    }
    if (script.includes("TUGRA_SRC_STATE_END")) {
      this.note("decommission-stop");
      const ids = [...script.matchAll(/'([a-f0-9]{12,64})'/g)].map((m) => m[1]);
      const lines = ids.map((id) => {
        const c = this.sourceContainers.find((x) => x.id === id);
        if (c) c.running = false;
        return `TUGRA_SRC_STATE id=${id} running=${c ? "false" : "absent"}`;
      });
      return ok([...lines, "TUGRA_SRC_STATE_END"].join("\n"));
    }
    this.note("unknown");
    return { exitCode: 1, output: "" };
  }
}

/** In-memory {@link CutoverWorld}: the swap table, the box (via {@link SimHost}) and the read-only queries. */
export class FakeWorld {
  swaps = new Map<string, SwapRow>();
  apps: OpApp[] = [];
  databaseIds: string[] = [];
  backups = new Map<string, boolean>();
  /** The other real runs of the same source (null = unreadable). */
  siblings: { live: number; undecommissioned: number } | null = { live: 0, undecommissioned: 0 };
  crashes: Array<{ name: string; ts: Date }> = [];
  server: ServerFacts = { id: SRV, name: "target", teamId: "team1", publicIp: IP, proxyBind: "public" };
  /** appId -> env names that point at an object store. */
  objectKeys = new Map<string, string[]>();
  /** What the attached object migrations say (null = nothing attached). */
  objects: ObjectsVerification | null = null;
  gitApps: GitWebhookApp[] = [];
  hubUrl: string | null = "https://hub.example.test";
  tokenActive = true;
  acmeKnown = true;
  otherLive = 0;
  calls: string[] = [];
  /**
   * Simulate the hub dying at the n-th (1-based) call of a MUTATING method, before the call takes effect or (`after`) right
   * after it did but before the caller saw the result. `methods` restricts which calls count (default: every mutating one).
   */
  crashAt: { n: number; after?: boolean; methods?: string[] } | null = null;
  private seen = 0;
  /** Number of mutating calls made so far (the crash matrix sizes itself from a clean run). */
  mutations = 0;
  now: () => Date = () => new Date();

  constructor(readonly host: SimHost) {}

  /** Run a mutating call through the crash injector. */
  private async guard<T>(method: string, body: () => T | Promise<T>): Promise<T> {
    this.calls.push(method);
    this.mutations++;
    const c = this.crashAt;
    if (c && (!c.methods || c.methods.includes(method))) {
      this.seen++;
      if (this.seen === c.n) {
        if (!c.after) throw new Crash(`${method}#${c.n}:before`);
        await body();
        throw new Crash(`${method}#${c.n}:after`);
      }
    }
    return body();
  }

  async opApps(): Promise<OpApp[]> {
    return this.apps;
  }
  async opDatabaseIds(): Promise<string[]> {
    return this.databaseIds;
  }
  /** Apps whose env cannot be read (the object-store dependency is unknown). */
  envUnreadable = new Set<string>();
  async appObjectEnv(ids: readonly string[]): Promise<{ keys: Map<string, string[]>; unreadable: string[] }> {
    return { keys: new Map([...this.objectKeys].filter(([id]) => ids.includes(id))), unreadable: ids.filter((id) => this.envUnreadable.has(id)).sort() };
  }
  async appObjectKeys(ids: readonly string[]): Promise<Map<string, string[]>> {
    return (await this.appObjectEnv(ids)).keys;
  }
  async objectsVerification(): Promise<ObjectsVerification | null> {
    return this.objects;
  }
  async gitWebhookApps(ids: readonly string[]): Promise<GitWebhookApp[]> {
    return this.gitApps.filter((g) => ids.includes(g.appId));
  }
  hubPublicUrl(): string | null {
    return this.hubUrl;
  }
  async opContainerNames(): Promise<string[]> {
    return [...this.apps.map((a) => `tugra_${a.appId}`), ...this.databaseIds.map((d) => `tugra_db_${d}`)];
  }
  async serverFacts(): Promise<ServerFacts | null> {
    return { ...this.server };
  }
  async setProxyBind(_serverId: string, bind: "public" | "loopback" | "none"): Promise<void> {
    return this.guard("setProxyBind", () => {
      this.server.proxyBind = bind;
    });
  }
  /** Read-only scripts (inspect/status/probes) are never crash points; every script that changes the box is. */
  async exec(_serverId: string, script: string): Promise<{ exitCode: number; output: string }> {
    const mutating = script.includes("docker update") || script.includes("docker stop") || script.includes("docker start");
    if (!mutating) {
      this.calls.push("exec:read");
      return this.host.exec(script);
    }
    return this.guard("exec", () => this.host.exec(script));
  }
  async otherLiveApps(): Promise<number> {
    return this.otherLive;
  }
  async acmeEmailKnown(): Promise<boolean> {
    return this.acmeKnown;
  }
  applied: string[] = [];
  /** The run's actor is the instance owner (the default). */
  owner = true;
  async isInstanceOwner(): Promise<boolean> {
    return this.owner;
  }
  async applyAcmeEmailIfMissing(email: string): Promise<boolean> {
    if (this.acmeKnown || !this.owner) return false;
    this.applied.push(email);
    this.acmeKnown = true;
    return true;
  }
  async migrationTokenActive(): Promise<boolean> {
    return this.tokenActive;
  }
  async revokeMigrationToken(): Promise<boolean> {
    return this.guard("revokeMigrationToken", () => {
      const was = this.tokenActive;
      this.tokenActive = false;
      return was;
    });
  }
  async getSwap(runId: string, serverId: string): Promise<SwapRow | null> {
    const r = this.swaps.get(`${runId}|${serverId}`);
    return r ? { ...r, coolifyProxy: { ...r.coolifyProxy } } : null;
  }
  async createSwap(runId: string, serverId: string, snapshot: CoolifyProxySnapshot, bindBefore: string): Promise<SwapRow> {
    return this.guard("createSwap", () => {
      const k = `${runId}|${serverId}`;
      const ex = this.swaps.get(k);
      if (ex) return { ...ex };
      const row: SwapRow = { id: `swap${this.swaps.size + 1}`, runId, serverId, state: "PLANNED", coolifyProxy: snapshot, tugraProxyBindBefore: bindBefore, liveAt: null };
      this.swaps.set(k, row);
      return { ...row };
    });
  }
  async setSwapState(runId: string, serverId: string, from: readonly SwapState[], to: SwapState): Promise<boolean> {
    return this.guard("setSwapState", () => {
      const r = this.swaps.get(`${runId}|${serverId}`);
      if (!r || !from.includes(r.state)) return false;
      r.state = to;
      if (to === "LIVE") r.liveAt = this.now();
      return true;
    });
  }
  async crashEventsSince(_serverId: string, names: readonly string[], since: Date): Promise<number> {
    return this.crashes.filter((c) => names.some((n) => c.name === n || c.name.startsWith(`${n}-`)) && c.ts >= since).length;
  }
  async siblingRuns(): Promise<{ live: number; undecommissioned: number }> {
    if (this.siblings === null) throw new Error("db down");
    return { ...this.siblings };
  }
  async backupCoverage(ids: readonly string[]): Promise<Array<{ databaseId: string; hasSuccess: boolean }>> {
    return ids.map((databaseId) => ({ databaseId, hasSuccess: this.backups.get(databaseId) === true }));
  }
}

export interface RigOpts {
  zone?: ZoneRec[];
  run?: Parameters<typeof makeRun>[0];
  options?: Partial<RunOptions>;
  /** Apps (id -> host, hasData) of the op. `serverId` places the app on another target server; `service` makes it a compose service (stopped unless `status` says otherwise). */
  apps?: Array<{ id: string; host: string; hasData?: boolean; serverId?: string; service?: boolean; status?: string; objectStore?: boolean }>;
}

/** Everything the cutover-side handlers need, wired to in-memory fakes around the REAL CutoverService. */
export function makeRig(o: RigOpts = {}) {
  const prisma = fakeCutoverPrisma();
  const { zone, cf } = fakeCloudflare(o.zone ?? []);
  prisma.__servers.set(SRV, { id: SRV, name: "target", proxyBind: "public", dnsCredentialId: "cred1", publicIp: IP, publicIpv6: null });
  const sim = { sslOk: true, httpStatus: 200, traefik404: false, propagated: true };
  const writes: Array<{ kind: string; phase: string; ponr: boolean }> = [];
  const phase = { current: "setup" };
  for (const k of ["createDnsRecord", "patchDnsRecord", "deleteDnsRecord"] as const) {
    const orig = cf[k] as unknown as (...a: unknown[]) => Promise<unknown>;
    (cf as unknown as Record<string, unknown>)[k] = jest.fn(async (...a: unknown[]) => {
      writes.push({ kind: k, phase: phase.current, ponr: driver.run.ponrAt !== null });
      return orig(...a);
    });
  }
  const access = { requirePermission: jest.fn(async () => undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const creds = {
    resolveToken: jest.fn(async () => ({ token: "TOK", cfAccountId: null, provider: "cloudflare", teamId: "team1" })),
    cloudflareCredentialsForTeam: jest.fn(async () => [{ id: "cred1", cfAccountId: null }]),
  };
  const lookup = {
    resolve4: jest.fn(async (h: string) => zone.records.filter((r) => r.name === h && r.type === "A").map((r) => r.content)),
    resolve6: jest.fn(async () => [] as string[]),
    resolveAuthoritative: jest.fn(async (h: string) => ({ addresses: sim.propagated ? zone.records.filter((r) => r.name === h && r.type === "A").map((r) => r.content) : [OLD], ttl: 3600, ns: ["ns1"] })),
    resolvePublic: jest.fn(async (h: string) => {
      const a = sim.propagated ? zone.records.filter((r) => r.name === h && r.type === "A").map((r) => r.content) : [OLD];
      return { "1.1.1.1": a, "8.8.8.8": a, "9.9.9.9": a };
    }),
  };
  const net = {
    sslAt: jest.fn(async () => (sim.sslOk ? { ok: true, issuer: "R3", subjectCN: "x", sans: [], validTo: new Date(Date.now() + 80 * 864e5).toISOString(), daysRemaining: 80 } : { ok: false, reason: "default-cert", issuer: null, subjectCN: "TRAEFIK DEFAULT CERT", sans: [], validTo: null, daysRemaining: null })),
    httpAt: jest.fn(async (_ip: string, _h: string, op: { tls: boolean }) => ({ status: op.tls ? sim.httpStatus : 301, traefik404: op.tls ? sim.traefik404 : false, location: op.tls ? null : "https://x/" })),
  };
  const proxyConfig = { resolveFor: jest.fn(async () => ({ acmeEmail: "ops@realco.io", bind: "public", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "x" } })) };
  const agentWs = { sendCommand: jest.fn(async () => ({ exitCode: 0, output: "" })) };
  const appsSvc = {
    setDomainOptions: jest.fn(async (_u: string, id: string, opts: { dnsChallenge?: boolean }) => {
      const a = prisma.__apps.get(id);
      if (a && opts.dnsChallenge !== undefined) a.dnsChallenge = opts.dnsChallenge;
    }),
    deploy: jest.fn(async () => ({ id: "dep1" })),
  };
  const tasks: Array<Record<string, unknown>> = [];
  const executor = { ownedOpForCutover: jest.fn(async () => ({ id: OP, meta: {}, cancelRequestedAt: null, tasks: tasks.map((t) => ({ result: { name: `src-${t.resourceId}` }, ...t })) })) };
  const dnsAuto = new DnsAutomationService(prisma as never, access as never, audit as never, cf as never, {} as never, creds as never, lookup as never);
  const cutover = new CutoverService(prisma as never, access as never, audit as never, executor as never, dnsAuto, creds as never, lookup as never, net as never, proxyConfig as never, agentWs as never, appsSvc as never);
  cutover.sleep = async () => undefined;

  const host = new SimHost();
  const world = new FakeWorld(host);
  // Only Date is faked (the cutover service reads the wall clock for its TTL/precheck windows); timers stay real.
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "queueMicrotask", "performance", "hrtime"] });
  const driver = new StepDriver(makeRun({ ...o.run, options: RunOptionsSchema.parse({ ...(o.options ?? {}) }) }));
  driver.syncClock();
  world.now = () => new Date(driver.now);
  host.onCommand = (kind) => {
    host.log[host.log.length - 1].ponr = driver.run.ponrAt !== null;
    void kind;
  };

  const proxyOps = {
    start: jest.fn(async () => {
      world.calls.push("proxyOps.start");
      if (host.coolifyComesBack && host.coolify) host.coolify.running = true;
      if (world.server.proxyBind === "public" && host.coolify?.running && host.startFailsOnPortConflict) {
        host.tugra = { status: "absent", ports: [] };
        throw new Error("reverse-proxy (Traefik) start failed: port is already allocated");
      }
      if (world.server.proxyBind === "public" && host.coolify?.running) host.tugra = { status: "absent", ports: [] };
      else host.tugra = { status: "running", ports: world.server.proxyBind === "public" ? ["80>80/tcp", "443>443/tcp"] : [] };
      return { status: "running" };
    }),
  };
  const certs = { seed: jest.fn(async () => ({ applied: 1 })) };

  const registry = new StepHandlerRegistryService();
  const dns = new DnsPrepareHandler(registry, cutover, world as unknown as CutoverWorld);
  const tls = new TlsPreissueHandler(registry, cutover, certs as never, world as unknown as CutoverWorld, proxyOps as never, appsSvc as never);
  const plans = new CutoverPlanService(cutover, world as unknown as CutoverWorld);
  const cut = new CutoverHandler(registry, cutover, world as unknown as CutoverWorld, proxyOps as never, net as never, plans);
  const obs = new ObserveHandler(registry, cutover, world as unknown as CutoverWorld, net as never);
  const fin = new FinalizeHandler(registry, cutover, world as unknown as CutoverWorld);
  const dec = new DecommissionHandler(registry, world as unknown as CutoverWorld);

  // The op's apps: the cutover service's own tables + the world's view of them.
  for (const a of o.apps ?? []) {
    const serverId = a.serverId ?? SRV;
    if (!prisma.__servers.has(serverId)) prisma.__servers.set(serverId, { id: serverId, name: serverId, proxyBind: "public", dnsCredentialId: "cred1", publicIp: `203.0.113.${100 + prisma.__servers.size}`, publicIpv6: null });
    prisma.__apps.set(a.id, { id: a.id, name: `app-${a.id}`, teamId: "team1", serverId, clusterId: null, domain: a.host, extraDomains: [], domainRedirect: null, dnsChallenge: false });
    tasks.push({ itemRef: `${a.service ? "service" : "app"}:_:${a.id}`, kind: a.service ? "service" : "app", status: "DONE", dependsOn: a.hasData && !a.service ? [`database:_:${a.id}`] : [], resourceType: "application", resourceId: a.id });
    if (a.hasData) tasks.push({ itemRef: `data:database:_:${a.id}`, kind: "data", status: "DONE", dependsOn: [], resourceType: null, resourceId: null });
    world.apps.push({ appId: a.id, itemRef: `${a.service ? "service" : "app"}:_:${a.id}`, hasData: a.hasData === true, domain: a.host, extraDomains: [], serviceHosts: [], clusterId: null, kind: a.service ? "service" : "app", serverId, status: a.status ?? (a.service ? "STOPPED" : "RUNNING"), objectStore: a.objectStore === true });
  }
  const row = (hostname: string) => prisma.cutoverDomain.rows.find((r) => r.hostname === hostname)!;
  const seat = async (state: string, hostnames?: string[]) => {
    for (const r of prisma.cutoverDomain.rows) if (!hostnames || hostnames.includes(r.hostname as string)) r.state = state;
  };
  return { prisma, zone, cf, sim, writes, phase, access, audit, creds, lookup, net, proxyConfig, agentWs, appsSvc, executor, cutover, host, world, driver, proxyOps, certs, registry, plans, handlers: { dns, tls, cut, obs, fin, dec }, tasks, row, seat };
}

export type Rig = ReturnType<typeof makeRig>;
export const stepKeys: StepKey[] = ["DNS_PREPARE", "TLS_PREISSUE", "CUTOVER", "OBSERVE", "FINALIZE", "DECOMMISSION"];
export { rec as zoneRec };
