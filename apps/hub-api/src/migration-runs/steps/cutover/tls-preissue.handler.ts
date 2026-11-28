import { Inject, Injectable, Optional } from "@nestjs/common";
import { isInPlaceRun } from "../inplace/inplace-run-logic";
import { APPLICATIONS_SERVICE } from "../../../applications/applications.tokens";
import type { ApplicationsService } from "../../../applications/applications.service";
import { CutoverService } from "../../../cutover/cutover.service";
import { CutoverCertService } from "../../../cutover/cutover-cert.service";
import { ProxyOpsService } from "../../../server-ops/proxy-ops.service";
import type { DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  StepFailure,
  isMultiTarget,
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
import { PostPonrRelease } from "../import/baseline/post-ponr";
import { CutoverStepBase, POLL_MS, rethrowLeaseLost, requireOpId } from "./cutover-step-base";
import { CutoverWorld, type OpApp } from "./cutover-world.service";
import { HTTP01_GAP_ATTEST, LEFT_OUT_ATTEST, gapAccepted, isLeftOut } from "./cutover-holds";
import { degradedAtSourceHosts, excuseDarkVerdicts } from "./baseline-hosts";
import { buildDarkProbeScript, classifyDarkHost, darkProbeChunks, parseDarkProbe, type DarkHostResult, type DarkVerdict } from "./dark-probe";
import { appHosts, cutoverInit } from "./dns-prepare.handler";
import { actionableEntries, capHosts, chk, compDate, compStrings, isDns01Blocked, iso, PRE_FLIP_STATES, trackedEntries, type Entry } from "./run-cutover-logic";
import type { CutoverView } from "../../../cutover/cutover.dto";

/** How long TLS_PREISSUE polls for certificates before it fails (retryable). DNS-01 issuance normally takes a minute or two. */
export const TLS_DEADLINE_MS = 20 * 60 * 1000;

export interface TlsObs extends Observation {
  opId: string | null;
  /** The apps of the op (a host belongs to its app's target server). */
  apps: OpApp[];
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
  /** The run's actor is the instance owner (the only one whose email may become the instance-wide ACME contact). */
  actorOwner: boolean;
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
    @Optional() private readonly release?: PostPonrRelease,
  ) {
    super(registry);
  }

  /** An in-place takeover has its own certificate work (Coolify's as a short fallback, a new one per domain), done in CUTOVER. */
  applicable(run: RunSnapshot): boolean {
    return !isInPlaceRun(run);
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
    if (run.topology === "swap-proxy" && isMultiTarget(run)) items.push({ code: "tls-preissue.dry.swap-multi-target", level: "block", params: { servers: ctx.targetServerIds.length } });
    return items;
  }

  async observe(ctx: StepContext): Promise<TlsObs> {
    const run = ctx.run;
    const opId = run.opId;
    const base: TlsObs = { opId, apps: [], topology: run.topology, entries: [], servers: [], certs: { staged: 0, applied: 0 }, hostApps: 0, dark: null, darkState: null, proxyBind: null, otherLiveApps: 0, acmeEmailKnown: false, actorOwner: false };
    if (!opId) return base;
    const [view, apps, facts, acmeEmailKnown, actorOwner] = await Promise.all([this.cutover.view(ctx.actor.userId, opId), this.world.opApps(opId), this.world.serverFacts(run.targetServerId), this.world.acmeEmailKnown(), this.world.isInstanceOwner(ctx.actor.userId)]);
    const otherLive = run.options.certs === "seed" ? await Promise.all(ctx.targetServerIds.map((sid) => this.world.otherLiveApps(sid, apps.map((a) => a.appId)))) : [];
    const obs: TlsObs = {
      ...base,
      apps,
      entries: view.entries,
      servers: view.servers,
      certs: view.certs,
      hostApps: apps.filter((a) => !a.clusterId && appHosts(a).length > 0).length,
      proxyBind: facts?.proxyBind ?? null,
      acmeEmailKnown,
      actorOwner,
      otherLiveApps: otherLive.reduce((a, b) => a + b, 0),
    };
    if (run.topology === "swap-proxy") {
      const hosts = actionableEntries(view.entries).map((e) => e.hostname);
      if (hosts.length > 0) {
        const probe = await this.darkProbe(run.targetServerId, hosts, run.options.healthPath ?? "/");
        obs.darkState = probe.state;
        // R52: an app that was already unhealthy at the source does not hold the certificate step back (its certificate is what this step is for)
        obs.dark = excuseDarkVerdicts(probe.verdicts, run.sourceBaseline, view.entries, apps);
      }
    }
    return obs;
  }

  /** One dark probe of the Tugra proxy on the swap host. Any transport trouble is `error` (unknown, never a pass). */
  private async darkProbe(serverId: string, hosts: string[], path: string): Promise<{ state: TlsObs["darkState"]; verdicts: Record<string, DarkVerdict> | null }> {
    try {
      const batch = darkProbeChunks(hosts);
      const all = batch.flat();
      const answers: Record<string, DarkHostResult> = {};
      for (const chunk of batch) {
        // On the box's own network: from the agent's bridge, tugra-proxy's isolated network never answers.
        const r = await this.world.exec(serverId, buildDarkProbeScript({ hosts: chunk, path }), 120_000, { hostNetwork: true });
        const parsed = parseDarkProbe(r.output, chunk);
        if (!parsed) return { state: "error", verdicts: null };
        if (parsed.kind !== "ok") return { state: parsed.kind, verdicts: null };
        Object.assign(answers, parsed.hosts);
      }
      return { state: "ok", verdicts: Object.fromEntries(all.map((h) => [h, classifyDarkHost(answers[h])])) };
    } catch (e) {
      rethrowLeaseLost(e);
      return { state: "error", verdicts: null };
    }
  }

  preGate(ctx: StepContext, obs: TlsObs): GateResult {
    const run = ctx.run;
    const checks: GateCheck[] = [chk("tls-preissue.import-op", obs.opId ? "pass" : "fail", "tls-preissue.import-op")];
    // The ACME email blocks TLS and CUTOVER only (owner question 3). It can only be judged once the target server is known
    // from the cutover view; before `init` the step may still run (act applies the run's own email when the instance has none).
    // A multi-target run issues certificates on every target server, so every one needs a usable ACME email.
    const provided = resolveOwnerInput(run.inputs, "acmeEmail");
    const servers = run.topology === "swap-proxy" ? obs.servers.filter((s) => s.serverId === run.targetServerId) : obs.servers;
    const emailCheck = (ok: boolean, subject?: string): GateCheck => {
      const o = subject ? { subject } : {};
      return ok ? chk("tls-preissue.acme-email", "pass", "tls-preissue.acme-email", { evidence: "hub-verified", ...o }) : provided && obs.actorOwner ? chk("tls-preissue.acme-email", "warn", "tls-preissue.acme-email-will-apply", o) : chk("tls-preissue.acme-email", "unknown", "tls-preissue.acme-email", { ownerInput: "acmeEmail", ...o });
    };
    if (servers.length > 0) for (const s of servers) checks.push(emailCheck(s.acmeEmailOk, servers.length > 1 ? s.name : undefined));
    else if (obs.entries.length > 0) checks.push(emailCheck(obs.acmeEmailKnown));
    // One swap moves one box: a run with several target servers needs one run per box (refused before anything is touched).
    if (run.topology === "swap-proxy" && isMultiTarget(run)) checks.push(chk("tls-preissue.swap-multi-target", "fail", "tls-preissue.swap-multi-target", { params: { servers: ctx.targetServerIds.length } }));
    if (run.options.certs === "seed" && obs.otherLiveApps > 0) checks.push(chk("tls-preissue.seed-live-apps", "fail", "tls-preissue.seed-would-drop-live-apps", { params: { count: obs.otherLiveApps } }));
    if (run.topology === "swap-proxy" && obs.proxyBind !== null && obs.proxyBind !== "none") checks.push(chk("tls-preissue.swap-bind", "warn", "tls-preissue.swap-bind-will-be-none", { params: { bind: obs.proxyBind } }));
    return makeGate(checks);
  }

  async act(ctx: StepContext, obs: TlsObs): Promise<ActResult> {
    const run = ctx.run;
    const userId = ctx.actor.userId;
    const opId = requireOpId(run, "tls-preissue.import-op");
    const now = ctx.now();
    if (run.topology === "swap-proxy" && isMultiTarget(run)) throw new StepFailure("tls-preissue.swap-multi-target", { servers: ctx.targetServerIds.length }, false);
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
    const emailMissing = view.servers.some((s) => !s.acmeEmailOk);
    if (email && emailMissing && !has("emailAt")) {
      // Instance-wide setting: only the instance owner's run may write it (the gate stays `unknown` until the owner sets it).
      if (await this.world.applyAcmeEmailIfMissing(email, userId)) {
        await ctx.recordCompensation({ emailAt: iso(now) });
        await ctx.emit({ stepKey: "TLS_PREISSUE", level: "info", code: "tls-preissue.acme-email-applied" });
      } else if (!has("emailSkippedAt") && !(await this.world.isInstanceOwner(userId))) {
        await ctx.recordCompensation({ emailSkippedAt: iso(now) });
        await ctx.emit({ stepKey: "TLS_PREISSUE", level: "warn", code: "tls-preissue.acme-email-owner-only" });
      }
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
      await this.prepareChallenges(ctx, opId, view, obs.apps);
      await ctx.recordCompensation({ preparedAt: iso(now) });
      view = await this.cutover.view(userId, opId);
    }

    let pollStartedAt = compDate(comp, "pollStartedAt") ?? startedAt;
    // An operator wait for the gap decision is not part of the polling window: it starts again when the step resumes.
    if (compDate(comp, "gapWaitAt")) {
      pollStartedAt = now;
      await ctx.recordCompensation({ gapWaitAt: null, pollStartedAt: iso(now) });
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
        await this.certs.seed(userId, opId, { ...(isMultiTarget(run) ? {} : { serverId: run.targetServerId }), acknowledgeProxyRestart: true });
        await ctx.emit({ stepKey: "TLS_PREISSUE", level: "info", code: "tls-preissue.certs-seeded", params: { staged: view.certs.staged } });
      }
      // The 20 minutes of polling start here: an operator wait for the staged certificates is not part of them.
      pollStartedAt = now;
      await ctx.recordCompensation({ seededAt: iso(now), pollStartedAt: iso(now) });
    }

    // 5. redeploy the apps whose router labels changed (once per app)
    const done = new Set(compStrings(comp, "redeployed"));
    // A held (or excluded) worker is never started before the cutover, whatever its router labels say (R26/C13): it is deployed
    // by the release after the point of no return, or not at all.
    const withheld = (await this.release?.withheldAppIds(ctx)) ?? new Set<string>();
    const todo = trackedEntries(view.entries).filter((e) => e.needsDeploy && !done.has(e.applicationId) && !withheld.has(e.applicationId));
    const skipped = [...new Set(trackedEntries(view.entries).filter((e) => e.needsDeploy && withheld.has(e.applicationId)).map((e) => e.applicationId))];
    const noted = new Set(compStrings(ctx.step.compensation, "withheldNoted"));
    if (skipped.some((id) => !noted.has(id))) {
      for (const id of skipped) noted.add(id);
      await ctx.recordCompensation({ withheldNoted: [...noted] });
      await ctx.emit({ stepKey: "TLS_PREISSUE", level: "warn", code: "tls-preissue.worker-not-redeployed", params: { count: skipped.length } });
    }
    for (const appId of [...new Set(todo.map((e) => e.applicationId))]) {
      await ctx.assertLease();
      // The key is stable across crashes (a re-entered call is deduplicated by the deploy queue); only a retry moves the generation.
      await this.apps.deploy(userId, appId, {}, `migrun:${run.id}:tls:${appId}:${gen}`);
      done.add(appId);
      await ctx.recordCompensation({ redeployed: [...done] });
      await ctx.emit({ stepKey: "TLS_PREISSUE", level: "info", code: "tls-preissue.redeploy", params: { app: appId } });
    }

    // 6. readiness: the cutover check promotes the host states (two-box); the dark probe is read in `observe` (swap)
    let entries = view.entries;
    if (run.topology === "two-box") {
      // A host whose gap the operator accepted AFTER the preparation moves to HTTP-01 now (per host, never for the whole run).
      await this.prepareAcceptedGaps(ctx, opId, entries);
      entries = (await this.cutover.check(userId, opId, { ...(run.options.healthPath ? { healthPath: run.options.healthPath } : {}) }, { degradedAtSource: await degradedAtSourceHosts(this.world, opId, run.sourceBaseline, entries) })).entries;
    }

    // C10: hosts that can only get a certificate after the flip wait for a decision PER HOST while every other host carries on.
    const decision = this.gapDecision(ctx, obs, entries);
    if (decision.pending.length > 0 && !decision.progressing) {
      await ctx.recordCompensation({ gapWaitAt: iso(now) });
      return { outcome: "wait", wait: { kind: "operator", code: "tls-preissue.http01-gap-hosts", params: { hosts: capHosts(decision.pending, 200), count: decision.pending.length }, attest: [HTTP01_GAP_ATTEST, LEFT_OUT_ATTEST] } };
    }

    if (now.getTime() - pollStartedAt.getTime() > TLS_DEADLINE_MS) throw new StepFailure("tls-preissue.timeout", { minutes: Math.round(TLS_DEADLINE_MS / 60_000) }, true);
    return { outcome: "continue", pollAfterMs: POLL_MS };
  }

  /** The target server of a host (the app's server; the run's default target for an app the world does not know). */
  private serverIdOf(ctx: StepContext, apps: readonly OpApp[]): (e: Entry) => string {
    const byApp = new Map(apps.map((a) => [a.appId, a.serverId ?? ""]));
    return (e) => byApp.get(e.applicationId) || ctx.run.targetServerId;
  }

  /** The operator left this host out of the run (on this step or CUTOVER): nothing is prepared or required for it. */
  private leftOut(ctx: StepContext, hostname: string): boolean {
    return isLeftOut(hostname, ctx.stepState("CUTOVER").evidence, ctx.step.evidence);
  }

  private gapOk(ctx: StepContext, e: { hostname: string }): boolean {
    return gapAccepted(e, ctx.run.options.acceptHttp01Gap, ctx.step.evidence, ctx.stepState("CUTOVER").evidence);
  }

  /** dns01 for the Cloudflare-covered hosts of a server that can do DNS-01, http01 for the rest (a gap needs its acceptance, per host). */
  private async prepareChallenges(ctx: StepContext, opId: string, view: CutoverView, apps: readonly OpApp[]): Promise<void> {
    const userId = ctx.actor.userId;
    const serverOf = this.serverIdOf(ctx, apps);
    const dnsReadyOf = (e: Entry): boolean => (view.servers.find((s) => s.serverId === serverOf(e)) ?? view.servers[0])?.dnsReady === true;
    const open = view.entries.filter((e) => ((PRE_FLIP_STATES as readonly string[]).includes(e.state) || isDns01Blocked(e)) && !this.leftOut(ctx, e.hostname));
    // Record each app's current challenge BEFORE changing it: the abort restores exactly this. First write wins per app: on a
    // retry or a crash after the change, the view already shows what THIS step set, which is not what the abort must restore.
    const prior = new Map<string, string>();
    for (const p of compStrings(ctx.step.compensation, "priorDnsChallenge")) {
      const [id] = p.split(":");
      if (id) prior.set(id, p);
    }
    for (const e of open) if (!prior.has(e.applicationId)) prior.set(e.applicationId, `${e.applicationId}:${e.challenge === "dns01" ? 1 : 0}`);
    await ctx.recordCompensation({ priorDnsChallenge: [...prior.values()] });
    const dns01 = open.filter((e) => dnsReadyOf(e) && e.dnsMode === "cloudflare" && e.state !== "BLOCKED").map((e) => e.hostname);
    // A host blocked only for DNS-01 reasons joins the HTTP-01 list when the owner accepted that gap for it; other blocks are left alone.
    const http01Hosts = open.filter((e) => !dns01.includes(e.hostname) && (e.state !== "BLOCKED" || this.gapOk(ctx, e)));
    const http01 = http01Hosts.map((e) => e.hostname);
    if (dns01.length) {
      await ctx.assertLease();
      const r = await this.cutover.certPrepare(userId, opId, { hostnames: dns01, challenge: "dns01" });
      if (r.blocked.length) await ctx.emit({ stepKey: "TLS_PREISSUE", level: "warn", code: "tls-preissue.dns01-blocked", params: { hosts: capHosts(r.blocked.map((b) => b.hostname)), reasons: [...new Set(r.blocked.map((b) => b.reason))] } });
      // A host DNS-01 could not serve falls back to HTTP-01 only when the owner accepted that gap for it.
      for (const b of r.blocked) if (this.gapOk(ctx, { hostname: b.hostname })) http01.push(b.hostname);
    }
    if (http01.length) {
      await ctx.assertLease();
      const accepted = http01.filter((h) => this.gapOk(ctx, { hostname: h }));
      const plain = http01.filter((h) => !accepted.includes(h));
      if (plain.length) await this.cutover.certPrepare(userId, opId, { hostnames: plain, challenge: "http01" });
      if (accepted.length) await this.cutover.certPrepare(userId, opId, { hostnames: accepted, challenge: "http01" }, { unblockDnsBlocked: true });
      await ctx.emit({ stepKey: "TLS_PREISSUE", level: accepted.length ? "warn" : "info", code: "tls-preissue.http01-hosts", params: { hosts: capHosts(http01), gapAccepted: accepted.length > 0 } });
    }
  }

  /** Hosts blocked only because DNS-01 could not be used, whose gap was accepted after the preparation: move them to HTTP-01 (once each). */
  private async prepareAcceptedGaps(ctx: StepContext, opId: string, entries: readonly Entry[]): Promise<void> {
    const done = compStrings(ctx.step.compensation, "gapPrepared");
    const todo = entries.filter((e) => isDns01Blocked(e) && !this.leftOut(ctx, e.hostname) && this.gapOk(ctx, e) && !done.includes(e.hostname)).map((e) => e.hostname);
    if (todo.length === 0) return;
    await ctx.assertLease();
    await ctx.recordCompensation({ gapPrepared: [...done, ...todo] });
    await this.cutover.certPrepare(ctx.actor.userId, opId, { hostnames: todo.slice(0, 200), challenge: "http01" }, { unblockDnsBlocked: true });
    await ctx.emit({ stepKey: "TLS_PREISSUE", level: "warn", code: "tls-preissue.http01-hosts", params: { hosts: capHosts(todo), gapAccepted: true } });
  }

  /**
   * Which hosts can only get a certificate after the flip (HTTP-01, or DNS-01 impossible) and have no accepted gap, and whether any
   * other host is still progressing on its own. Only when nothing else is progressing does the step ask the operator.
   */
  private gapDecision(ctx: StepContext, obs: TlsObs, entries: readonly Entry[]): { pending: string[]; progressing: boolean } {
    const pending: string[] = [];
    let progressing = false;
    for (const e of entries) {
      if (e.state === "EXCLUDED" || e.state === "ROLLED_BACK" || this.leftOut(ctx, e.hostname)) continue;
      const accepted = this.gapOk(ctx, e);
      if (e.state === "BLOCKED") {
        if (isDns01Blocked(e)) {
          if (accepted) progressing = true;
          else pending.push(e.hostname);
        }
        continue;
      }
      if (obs.topology === "swap-proxy") {
        const v = obs.dark?.[e.hostname];
        if (!v) progressing = true;
        else if (!v.ready) {
          // Only an HTTP-01 host can be waiting for the gap decision; a DNS-01 host's certificate is still being issued.
          const gapOnly = e.challenge === "http01" && v.tls !== "ok" && ["ok", "redirect", "auth", "app-404"].includes(v.health);
          if (!gapOnly) progressing = true;
          else if (!accepted) pending.push(e.hostname);
        }
        continue;
      }
      if (e.state !== "READY") progressing = true;
      else if (e.certState !== "ready" && e.challenge === "http01" && !accepted) pending.push(e.hostname);
      else if (e.certState !== "ready" && e.challenge !== "http01") progressing = true;
    }
    return { pending, progressing };
  }

  postGate(ctx: StepContext, obs: TlsObs): GateResult {
    if (!obs.opId) return makeGate([chk("tls-preissue.hosts-ready", "fail", "tls-preissue.import-op")]);
    if (obs.hostApps === 0) return makeGate([chk("tls-preissue.hosts-ready", "pass", "tls-preissue.no-hosts", { evidence: "hub-verified" })]);
    if (obs.entries.length === 0) return makeGate([chk("tls-preissue.hosts-ready", "fail", "tls-preissue.hosts-not-derived")]);
    const checks: GateCheck[] = [];
    for (const e of obs.entries) {
      const gap = this.gapOk(ctx, e);
      if (e.state === "EXCLUDED" || e.state === "ROLLED_BACK") continue;
      if (this.leftOut(ctx, e.hostname)) {
        checks.push(chk("tls-preissue.host", "warn", "tls-preissue.host-left-out", { subject: e.hostname }));
        continue;
      }
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
    if (v.ready && v.preExisting) return chk("tls-preissue.host", "warn", "tls-preissue.dark-pre-existing", { subject: e.hostname, evidence: "source-api-reported", params: { health: v.health } });
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
