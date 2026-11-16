import { Inject, Injectable } from "@nestjs/common";
import { CutoverService } from "../../../cutover/cutover.service";
import type { DryRunItem, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  makeGate,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type RunSnapshot,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { CutoverStepBase } from "./cutover-step-base";
import { CutoverWorld, type OpApp } from "./cutover-world.service";
import { capHosts, chk, isDnsPrepared, iso, trackedEntries, ttlWaitUntil, type Entry } from "./run-cutover-logic";

/** Hosts per manual-DNS guidance event (the web cuts a list at five). */
const GUIDANCE_CHUNK = 5;

export interface DnsPrepareObs extends Observation {
  opId: string | null;
  entries: Entry[];
  /** Apps of the op that serve at least one hostname (0 = nothing to prepare). */
  hostApps: number;
}

/** The hosts an app serves (primary, aliases, compose service domains), lower-cased and de-duplicated. */
export function appHosts(a: OpApp): string[] {
  return [...new Set([a.domain, ...a.extraDomains, ...a.serviceHosts].filter((h): h is string => !!h).map((h) => h.toLowerCase()))];
}

/**
 * DNS_PREPARE (two-box only): derive the hostnames from the imported apps and lower their TTL right after IMPORT, so the
 * old TTL elapses WHILE the data seeds (design 3.3). The step passes as soon as the TTLs are set; the wait itself is
 * recorded (`compensation.ttlWaitUntil`) and enforced by CUTOVER's pre-gate and by the cutover service's own flip gate.
 * Never writes anything except a provider TTL; the reverse puts the TTL back.
 */
@Injectable()
export class DnsPrepareHandler extends CutoverStepBase implements StepHandler<DnsPrepareObs> {
  readonly key = "DNS_PREPARE" as const;
  readonly kind = "timer" as const;
  readonly rollback = "UNDOABLE" as const;

  constructor(
    @Inject(STEP_HANDLERS) registry: StepHandlerRegistry,
    private readonly cutover: CutoverService,
    private readonly world: CutoverWorld,
  ) {
    super(registry);
  }

  /** A same-host swap changes no DNS record (the IP is unchanged), so there is nothing to prepare. */
  applicable(run: RunSnapshot): boolean {
    return run.topology === "two-box";
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const opId = ctx.run.opId;
    if (!opId) return [{ code: "dns-prepare.dry.hosts-after-import", level: "info" }];
    const apps = await this.world.opApps(opId);
    const hosts = [...new Set(apps.filter((a) => !a.clusterId).flatMap(appHosts))];
    return [
      { code: "dns-prepare.dry.would-lower-ttl", level: hosts.length ? "info" : "warn", params: { hosts: capHosts(hosts), count: hosts.length } },
      ...(ctx.run.options.ttlPolicy === "skip-ack" ? [{ code: "dns-prepare.dry.ttl-wait-skipped", level: "warn" as const }] : []),
    ];
  }

  async observe(ctx: StepContext): Promise<DnsPrepareObs> {
    const opId = ctx.run.opId;
    if (!opId) return { opId: null, entries: [], hostApps: 0 };
    const [view, apps] = await Promise.all([this.cutover.view(ctx.actor.userId, opId), this.world.opApps(opId)]);
    return { opId, entries: view.entries, hostApps: apps.filter((a) => !a.clusterId && appHosts(a).length > 0).length };
  }

  preGate(_ctx: StepContext, obs: DnsPrepareObs): GateResult {
    return makeGate([chk("dns-prepare.import-op", obs.opId ? "pass" : "fail", "dns-prepare.import-op")]);
  }

  async act(ctx: StepContext, obs: DnsPrepareObs): Promise<ActResult> {
    const opId = obs.opId!;
    const userId = ctx.actor.userId;
    await ctx.assertLease();
    // Derive/refresh the tracked hosts. Read-only toward every DNS provider.
    await ctx.recordCompensation({ initRequestedAt: iso(ctx.now()) });
    await cutoverInit(this.cutover, ctx, opId);
    // The provider write (TTL) is recorded BEFORE it is issued, so an abort after a crash still knows to restore it.
    await ctx.recordCompensation({ ttlRequestedAt: iso(ctx.now()) });
    await ctx.assertLease();
    const t = await this.cutover.ttl(userId, opId, {});
    const entries = t.view.entries;
    const skip = ctx.run.options.ttlPolicy === "skip-ack";
    const until = skip ? null : ttlWaitUntil(entries);
    await ctx.recordCompensation({ ttlWaitUntil: until ? iso(until) : null, manualHosts: capHosts(t.guidance.map((g) => g.hostname)) });
    const lowered = entries.filter((e) => e.dnsMode === "cloudflare" && e.ttlWaitUntil !== null).length;
    await ctx.emit({ stepKey: "DNS_PREPARE", level: "info", code: "dns-prepare.ttl-lowered", params: { hosts: lowered, tracked: trackedEntries(entries).length } });
    // Customer-owned zones (C10): each host's own TTL guidance (current TTL and the moment to lower it by) so the checklist can be worked per host.
    // The web shows at most five list items per message, so the checklist goes out in events of five hosts: none is cut off.
    for (let i = 0; i < Math.min(t.guidance.length, GUIDANCE_CHUNK * 40); i += GUIDANCE_CHUNK) {
      const part = t.guidance.slice(i, i + GUIDANCE_CHUNK);
      await ctx.emit({ stepKey: "DNS_PREPARE", level: "info", code: "dns-prepare.manual-dns-guidance", params: { hosts: part.map((g) => g.hostname), count: t.guidance.length, ttl: part.map((g) => `${g.hostname} ttl=${g.oldTtl} lower-before=${g.lowerBefore}`.slice(0, 300)) } });
    }
    const blocked = entries.filter((e) => e.state === "BLOCKED").map((e) => e.hostname);
    if (blocked.length) await ctx.emit({ stepKey: "DNS_PREPARE", level: "warn", code: "dns-prepare.hosts-blocked", params: { hosts: capHosts(blocked) } });
    if (skip) await ctx.emit({ stepKey: "DNS_PREPARE", level: "warn", code: "dns-prepare.ttl-wait-skipped" });
    else if (until) await ctx.emit({ stepKey: "DNS_PREPARE", level: "info", code: "dns-prepare.ttl-wait", params: { until: iso(until) } });
    return { outcome: "done" };
  }

  postGate(_ctx: StepContext, obs: DnsPrepareObs): GateResult {
    if (!obs.opId) return makeGate([chk("dns-prepare.hosts-prepared", "fail", "dns-prepare.import-op")]);
    // Nothing to prepare when the op's apps serve no hostname (also reached before `act` ever ran: then the step is a no-op).
    if (obs.hostApps === 0) return makeGate([chk("dns-prepare.hosts-prepared", "pass", "dns-prepare.no-hosts", { evidence: "hub-verified" })]);
    const tracked = trackedEntries(obs.entries);
    const prepared = tracked.filter(isDnsPrepared).length;
    const checks = [chk("dns-prepare.hosts-prepared", obs.entries.length > 0 && prepared === tracked.length ? "pass" : "fail", "dns-prepare.hosts-prepared", { params: { prepared, total: tracked.length }, evidence: "hub-verified" })];
    for (const e of obs.entries) if (e.state === "BLOCKED") checks.push(chk("dns-prepare.host-blocked", "warn", "dns-prepare.host-blocked", { subject: e.hostname, params: { reason: e.blockReason ?? "blocked" } }));
    return makeGate(checks);
  }

  /** abort: put the TTL back on every host that was lowered but never flipped. cleanup/reverse: a flipped host's own revert restores its records. */
  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    if (how !== "abort" || !ctx.run.opId) return { outcome: "nothing-to-do" };
    const n = await this.cutover.restoreTtlsUnflipped(ctx.actor.userId, ctx.run.opId);
    await ctx.emit({ stepKey: "DNS_PREPARE", level: "info", code: "dns-prepare.ttl-restored", params: { records: n } });
    return n > 0 ? { outcome: "done" } : { outcome: "nothing-to-do" };
  }
}

/** `cutover.init` with the run's pinned DNS credential, when it set one. */
export async function cutoverInit(cutover: CutoverService, ctx: StepContext, opId: string): Promise<void> {
  const id = ctx.run.options.dnsCredentialId;
  await cutover.init(ctx.actor.userId, opId, id ? { dnsCredentialId: id } : {});
}
