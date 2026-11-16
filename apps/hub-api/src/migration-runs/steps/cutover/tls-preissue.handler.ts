import { Inject, Injectable } from "@nestjs/common";
import { APPLICATIONS_SERVICE } from "../../../applications/applications.tokens";
import type { ApplicationsService } from "../../../applications/applications.service";
import { CutoverService } from "../../../cutover/cutover.service";
import { CutoverCertService } from "../../../cutover/cutover-cert.service";
import { ProxyOpsService } from "../../../server-ops/proxy-ops.service";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  StepFailure,
  makeGate,
  resolveOwnerInput,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type RunSnapshot,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { CutoverStepBase, POLL_MS, requireOpId } from "./cutover-step-base";
import { CutoverWorld } from "./cutover-world.service";
import { buildDarkProbeScript, classifyDarkHost, parseDarkProbe, type DarkVerdict } from "./dark-probe";
import { cutoverInit } from "./dns-prepare.handler";
import { appHosts } from "./dns-prepare.handler";
import { actionableEntries, capHosts, chk, compDate, compStrings, isDns01Blocked, iso, PRE_FLIP_STATES, trackedEntries, type Entry } from "./run-cutover-logic";
import type { CutoverView } from "../../../cutover/cutover.dto";

/** How long TLS_PREISSUE polls for certificates before it fails (retryable). DNS-01 issuance normally takes a minute or two. */
export const TLS_DEADLINE_MS = 20 * 60 * 1000;

export interface TlsObs extends Observation {
  opId: string | null;
  topology: RunSnapshot["topology"];
  entries: Entry[];
  servers: CutoverView["servers"];
  certs: CutoverView["certs"];
  /** Apps of the op that serve at least one hostname (0 = nothing to issue). */
  hostApps: number;
  /** swap-proxy only: per-host dark-probe verdicts (null when the probe did not run or could not answer). */
  dark: Record<string, DarkVerdict> | null;
  darkState: "ok" | "no-proxy" | "unavailable" | "error" | null;
  proxyBind: string | null;
  otherLiveApps: number;
  acmeEmailKnown: boolean;
}

/**
 * TLS_PREISSUE: have every host's certificate ready on the dark Tugra proxy BEFORE any traffic moves. DNS-01 where a
 * credential covers the zone (the only option on a swap host, where Coolify still owns :80), else HTTP-01 behind the
 * explicit `acceptHttp01Gap`. Redeploys the apps whose router labels changed, seeds the source's certs when chosen, and
 * polls readiness: `cutover.check` for a two-box target, the dark probe for a same-host swap.
 *
 * Touches no DNS record and no traffic. The reverse restores the per-app challenge setting it recorded first.
 */
@Injectable()
export class TlsPreissueHandler extends CutoverStepBase implements StepHandler<TlsObs> {
  readonly key = "TLS_PREISSUE" as const;
  readonly kind = "auto" as const;
  readonly rollback = "UNDOABLE" as const;

  constructor(
    @Inject(STEP_HANDLERS) registry: StepHandlerRegistry,
    private readonly cutover: CutoverService,
    private readonly certs: CutoverCertService,
    private readonly world: CutoverWorld,
    private readonly proxyOps: ProxyOpsService,
    @Inject(APPLICATIONS_SERVICE) private readonly apps: ApplicationsService,
  ) {
    super(registry);
  }

  applicable(): boolean {
    return true;
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const run = ctx.run;
    const items: DryRunItem[] = [{ code: "tls-preissue.dry.mode", level: "info", params: { topology: run.topology, certs: run.options.certs } }];
    if (run.opId) {
      const apps = await this.world.opApps(run.opId);
      const hosts = [...new Set(apps.filter((a) => !a.clusterId).flatMap(appHosts))];
      items.push({ code: "tls-preissue.dry.hosts", level: hosts.length ? "info" : "warn", params: { hosts: capHosts(hosts), count: hosts.length } });
    }
    if (!resolveOwnerInput(run.inputs, "acmeEmail") && !(await this.world.acmeEmailKnown())) items.push({ code: "tls-preissue.acme-email", level: "unknown" });
    if (run.topology === "swap-proxy" && !run.options.acceptHttp01Gap && run.options.certs === "none") items.push({ code: "tls-preissue.dry.dns01-required", level: "info" });
    return items;
  }

  async observe(ctx: StepContext): Promise<TlsObs> {
    const run = ctx.run;
    const opId = run.opId;
    const base: TlsObs = { opId, topology: run.topology, entries: [], servers: [], certs: { staged: 0, applied: 0 }, hostApps: 0, dark: null, darkState: null, proxyBind: null, otherLiveApps: 0, acmeEmailKnown: false };
    if (!opId) return base;
    const [view, apps, facts, acmeEmailKnown] = await Promise.all([this.cutover.view(ctx.actor.userId, opId), this.world.opApps(opId), this.world.serverFacts(run.targetServerId), this.world.acmeEmailKnown()]);
    const obs: TlsObs = {
      ...base,
      entries: view.entries,
      servers: view.servers,
      certs: view.certs,
      hostApps: apps.filter((a) => !a.clusterId && appHosts(a).length > 0).length,
      proxyBind: facts?.proxyBind ?? null,
      acmeEmailKnown,
      otherLiveApps: run.options.certs === "seed" ? await this.world.otherLiveApps(run.targetServerId, apps.map((a) => a.appId)) : 0,
    };
    if (run.topology === "swap-proxy") {
      const hosts = actionableEntries(view.entries).map((e) => e.hostname);
      if (hosts.length > 0) {
        const probe = await this.darkProbe(run.targetServerId, hosts, run.options.healthPath ?? "/");
        obs.darkState = probe.state;
        obs.dark = probe.verdicts;
      }
    }
    return obs;
  }

  /** One dark probe of the Tugra proxy on the swap host. Any transport trouble is `error` (unknown, never a pass). */
  private async darkProbe(serverId: string, hosts: string[], path: string): Promise<{ state: TlsObs["darkState"]; verdicts: Record<string, DarkVerdict> | null }> {
    try {
      const batch = hosts.slice(0, 100);
      const r = await this.world.exec(serverId, buildDarkProbeScript({ hosts: batch, path }), 120_000);
      const parsed = parseDarkProbe(r.output, batch);
      if (!parsed) return { state: "error", verdicts: null };
      if (parsed.kind !== "ok") return { state: parsed.kind, verdicts: null };
      return { state: "ok", verdicts: Object.fromEntries(batch.map((h) => [h, classifyDarkHost(parsed.hosts[h])])) };
    } catch {
      return { state: "error", verdicts: null };
    }
  }

  preGate(ctx: StepContext, obs: TlsObs): GateResult {
    const run = ctx.run;
    const checks: GateCheck[] = [chk("tls-preissue.import-op", obs.opId ? "pass" : "fail", "tls-preissue.import-op")];
    // The ACME email blocks TLS and CUTOVER only (owner question 3). It can only be judged once the target server is known
    // from the cutover view; before `init` the step may still run (act applies the run's own email when the instance has none).
    const server = obs.servers.find((s) => s.serverId === run.targetServerId);
    const provided = resolveOwnerInput(run.inputs, "acmeEmail");
    if (server || obs.entries.length > 0) {
      const ok = server ? server.acmeEmailOk : obs.acmeEmailKnown;
      checks.push(ok ? chk("tls-preissue.acme-email", "pass", "tls-preissue.acme-email", { evidence: "hub-verified" }) : provided ? chk("tls-preissue.acme-email", "warn", "tls-preissue.acme-email-will-apply") : chk("tls-preissue.acme-email", "unknown", "tls-preissue.acme-email", { ownerInput: "acmeEmail" }));
    }
    if (run.options.certs === "seed" && obs.otherLiveApps > 0) checks.push(chk("tls-preissue.seed-live-apps", "fail", "tls-preissue.seed-would-drop-live-apps", { params: { count: obs.otherLiveApps } }));
    if (run.topology === "swap-proxy" && obs.proxyBind !== null && obs.proxyBind !== "none") checks.push(chk("tls-preissue.swap-bind", "warn", "tls-preissue.swap-bind-will-be-none", { params: { bind: obs.proxyBind } }));
    return makeGate(checks);
  }

  async act(ctx: StepContext, obs: TlsObs): Promise<ActResult> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    const opId = requireOpId(run, "tls-preissue.import-op");
    const now = ctx.now();
    // A retry redoes the preparation (markers are ignored, the redeploy generation moves on); every other entry resumes after the markers.
    const raw = ctx.step.compensation ?? {};
    const retry = ctx.trigger === "retry";
    const gen = (typeof raw.redeployGen === "number" ? raw.redeployGen : 0) + (retry ? 1 : 0);
    if (retry) await ctx.recordCompensation({ redeployGen: gen, redeployed: [] });
    const comp: Readonly<Record<string, unknown>> = retry ? {} : raw;
    const has = (k: string) => typeof comp[k] === "string";
    const startedAt = compDate(comp, "startedAt") ?? now;
    if (!has("startedAt")) await ctx.recordCompensation({ startedAt: iso(now) });

    // 0. the tracked hosts (read-only toward DNS); refreshed after the data moved so `stateful` and the challenge are current
    if (!has("initAt")) {
      await cutoverInit(this.cutover, ctx, opId);
      await ctx.recordCompensation({ initAt: iso(now) });
    }
    let view = await this.cutover.view(userId, opId);

    // 1. the ACME email the run was given, when the instance has none
    const email = resolveOwnerInput(run.inputs, "acmeEmail");
    const server = view.servers.find((s) => s.serverId === run.targetServerId);
    if (email && server && !server.acmeEmailOk && !has("emailAt")) {
      await this.world.applyAcmeEmailIfMissing(email);
      await ctx.recordCompensation({ emailAt: iso(now) });
      await ctx.emit({ stepKey: "TLS_PREISSUE", level: "info", code: "tls-preissue.acme-email-applied" });
    }

    // 2. swap host: the dark proxy must publish no port while Coolify owns :80/:443
    if (run.topology === "swap-proxy" && !has("bindAt")) {
      const facts = await this.world.serverFacts(run.targetServerId);
      if (facts && facts.proxyBind !== "none") {
        const live = await this.world.otherLiveApps(run.targetServerId, (await this.world.opApps(opId)).map((a) => a.appId));
        if (live > 0) throw new StepFailure("tls-preissue.swap-bind-needs-restart", { count: live }, true);
        await ctx.recordCompensation({ bindPrev: facts.proxyBind });
        await this.world.setProxyBind(run.targetServerId, "none");
        await this.proxyOps.start(userId, run.targetServerId);
        await ctx.emit({ stepKey: "TLS_PREISSUE", level: "info", code: "tls-preissue.swap-bind-none", params: { was: facts.proxyBind } });
      }
      await ctx.recordCompensation({ bindAt: iso(now) });
    }

    // 3. the challenge per host
    if (!has("preparedAt")) {
      await this.prepareChallenges(ctx, opId, view);
      await ctx.recordCompensation({ preparedAt: iso(now) });
      view = await this.cutover.view(userId, opId);
    }

    // 4. the source's own certificates, when the run chose to seed them (they arrive from the migrator's --certs pass)
    if (run.options.certs === "seed" && !has("seededAt")) {
      if (view.certs.staged === 0 && view.certs.applied === 0) {
        return { outcome: "wait", wait: { kind: "operator", code: "tls-preissue.certs-not-staged" } };
      }
      if (view.certs.staged > 0) {
        await ctx.recordCompensation({ seedRequestedAt: iso(now) });
        await ctx.assertLease();
        // The Tugra proxy is dark (no traffic moved yet) and the pre-gate refused a server with other live apps, so the
        // restart `seed` needs is acknowledged by construction.
        await this.certs.seed(userId, opId, { serverId: run.targetServerId, acknowledgeProxyRestart: true });
        await ctx.emit({ stepKey: "TLS_PREISSUE", level: "info", code: "tls-preissue.certs-seeded", params: { staged: view.certs.staged } });
      }
      await ctx.recordCompensation({ seededAt: iso(now) });
    }

    // 5. redeploy the apps whose router labels changed (once per app)
    const done = new Set(compStrings(comp, "redeployed"));
    const todo = trackedEntries(view.entries).filter((e) => e.needsDeploy && !done.has(e.applicationId));
    for (const appId of [...new Set(todo.map((e) => e.applicationId))]) {
      await ctx.assertLease();
      // The key is stable across crashes (a re-entered call is deduplicated by the deploy queue); only a retry moves the generation.
      await this.apps.deploy(userId, appId, {}, `migrun:${run.id}:tls:${appId}:${gen}`);
      done.add(appId);
      await ctx.recordCompensation({ redeployed: [...done] });
      await ctx.emit({ stepKey: "TLS_PREISSUE", level: "info", code: "tls-preissue.redeploy", params: { app: appId } });
    }

    // 6. readiness: the cutover check promotes the host states (two-box); the dark probe is read in `observe` (swap)
    if (run.topology === "two-box") await this.cutover.check(userId, opId, { ...(run.options.healthPath ? { healthPath: run.options.healthPath } : {}) });

    if (now.getTime() - startedAt.getTime() > TLS_DEADLINE_MS) throw new StepFailure("tls-preissue.timeout", { minutes: Math.round(TLS_DEADLINE_MS / 60_000) }, true);
    return { outcome: "continue", pollAfterMs: POLL_MS };
  }

  /** dns01 for the Cloudflare-covered hosts (when the server can do DNS-01), http01 for the rest. */
  private async prepareChallenges(ctx: StepContext, opId: string, view: CutoverView): Promise<void> {
    const userId = ctx.actor.userId;
    const server = view.servers.find((s) => s.serverId === ctx.run.targetServerId) ?? view.servers[0];
    const dnsReady = server?.dnsReady === true;
    const gap = ctx.run.options.acceptHttp01Gap;
    const open = view.entries.filter((e) => (PRE_FLIP_STATES as readonly string[]).includes(e.state) || isDns01Blocked(e));
    // Record each app's current challenge BEFORE changing it: the abort restores exactly this.
    const prior: Record<string, boolean> = {};
    for (const e of open) prior[e.applicationId] = e.challenge === "dns01";
    await ctx.recordCompensation({ priorDnsChallenge: Object.entries(prior).map(([id, on]) => `${id}:${on ? 1 : 0}`) });
    const dns01 = dnsReady ? open.filter((e) => e.dnsMode === "cloudflare" && e.state !== "BLOCKED").map((e) => e.hostname) : [];
    // A host blocked only for DNS-01 reasons joins the HTTP-01 list when the owner accepted that gap; other blocks are left alone.
    const http01 = open.filter((e) => !dns01.includes(e.hostname) && (e.state !== "BLOCKED" || gap)).map((e) => e.hostname);
    if (dns01.length) {
      await ctx.assertLease();
      const r = await this.cutover.certPrepare(userId, opId, { hostnames: dns01, challenge: "dns01" });
      if (r.blocked.length) await ctx.emit({ stepKey: "TLS_PREISSUE", level: "warn", code: "tls-preissue.dns01-blocked", params: { hosts: capHosts(r.blocked.map((b) => b.hostname)), reasons: [...new Set(r.blocked.map((b) => b.reason))] } });
      // A host DNS-01 could not serve falls back to HTTP-01 only when the owner accepted that gap.
      if (gap) http01.push(...r.blocked.map((b) => b.hostname));
    }
    if (http01.length) {
      await ctx.assertLease();
      await this.cutover.certPrepare(userId, opId, { hostnames: http01, challenge: "http01" }, { unblockDnsBlocked: gap });
      await ctx.emit({ stepKey: "TLS_PREISSUE", level: gap ? "warn" : "info", code: "tls-preissue.http01-hosts", params: { hosts: capHosts(http01), gapAccepted: gap } });
    }
  }

  postGate(ctx: StepContext, obs: TlsObs): GateResult {
    if (!obs.opId) return makeGate([chk("tls-preissue.hosts-ready", "fail", "tls-preissue.import-op")]);
    if (obs.hostApps === 0) return makeGate([chk("tls-preissue.hosts-ready", "pass", "tls-preissue.no-hosts", { evidence: "hub-verified" })]);
    if (obs.entries.length === 0) return makeGate([chk("tls-preissue.hosts-ready", "fail", "tls-preissue.hosts-not-derived")]);
    const gap = ctx.run.options.acceptHttp01Gap;
    const checks: GateCheck[] = [];
    for (const e of obs.entries) {
      if (e.state === "EXCLUDED" || e.state === "ROLLED_BACK") continue;
      if (e.state === "BLOCKED") {
        checks.push(isDns01Blocked(e) ? chk("tls-preissue.host", "fail", "tls-preissue.dns01-blocked", { subject: e.hostname, params: { reason: e.blockReason ?? "blocked" } }) : chk("tls-preissue.host", "warn", "tls-preissue.host-blocked", { subject: e.hostname, params: { reason: e.blockReason ?? "blocked" } }));
        continue;
      }
      checks.push(obs.topology === "swap-proxy" ? this.swapHostCheck(e, obs, gap) : this.boxHostCheck(e, gap));
    }
    if (obs.topology === "swap-proxy" && obs.darkState && obs.darkState !== "ok") checks.push(chk("tls-preissue.dark-probe", "fail", `tls-preissue.dark-probe-${obs.darkState}`));
    return makeGate(checks);
  }

  private boxHostCheck(e: Entry, gap: boolean): GateCheck {
    if (e.state === "READY") {
      if (e.certState === "ready") return chk("tls-preissue.host", "pass", "tls-preissue.host-ready", { subject: e.hostname, evidence: "hub-verified" });
      if (e.challenge === "http01" && gap) return chk("tls-preissue.host", "warn", "tls-preissue.http01-gap", { subject: e.hostname, evidence: "hub-verified" });
      return chk("tls-preissue.host", "fail", "tls-preissue.http01-gap-not-accepted", { subject: e.hostname });
    }
    return chk("tls-preissue.host", "fail", "tls-preissue.host-not-ready", { subject: e.hostname, params: { state: e.state, cert: e.certState, ...(e.certError ? { error: e.certError.slice(0, 200) } : {}) } });
  }

  private swapHostCheck(e: Entry, obs: TlsObs, gap: boolean): GateCheck {
    const v = obs.dark?.[e.hostname];
    if (!v) return chk("tls-preissue.host", "fail", "tls-preissue.dark-unknown", { subject: e.hostname });
    if (v.ready) return chk("tls-preissue.host", "pass", "tls-preissue.host-ready", { subject: e.hostname, evidence: "hub-verified", params: { health: v.health } });
    // HTTP-01 cannot issue while Coolify owns :80: the owner may accept that the certificate arrives right after the swap.
    if (gap && v.tls !== "ok" && (v.health === "ok" || v.health === "redirect" || v.health === "auth" || v.health === "app-404")) return chk("tls-preissue.host", "warn", "tls-preissue.http01-gap", { subject: e.hostname, evidence: "hub-verified" });
    return chk("tls-preissue.host", "fail", "tls-preissue.dark-not-ready", { subject: e.hostname, params: { tls: v.tls, health: v.health } });
  }

  /** abort: put each app's DNS-01 setting back to what it was. The dark proxy keeps `proxyBind: none` (Coolify still owns :80) and the operator is told. */
  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how !== "abort") return { outcome: "nothing-to-do" };
    const prior = compStrings(ctx.step.compensation, "priorDnsChallenge");
    let changed = 0;
    for (const p of prior) {
      const [appId, on] = p.split(":");
      if (!appId || (on !== "0" && on !== "1")) continue;
      // Only ever switch DNS-01 OFF again (re-enabling would re-assert credentials the abort cannot guarantee).
      if (on === "0") {
        await this.apps.setDomainOptions(ctx.actor.userId, appId, { dnsChallenge: false });
        changed++;
      }
    }
    const manual = ctx.run.topology === "swap-proxy" ? [{ code: "tls-preissue.bind-left-none" }] : undefined;
    if (changed === 0 && !manual) return { outcome: "nothing-to-do" };
    return { outcome: manual ? "manual" : "done", ...(manual ? { manual } : {}) };
  }
}
