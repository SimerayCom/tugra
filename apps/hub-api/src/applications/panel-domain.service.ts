import { BadRequestException, ConflictException, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AuditService } from "../audit/audit.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { PANEL_PENDING_KEY, PANEL_PENDING_TTL_S } from "../proxy-config/panel-pending";
import { optionalAcmeEmail, validatePanelDomain } from "../deploy/panel-router";
import { PROXY_NAME } from "../deploy/deploy-script";
import { UPDATE_LOCK_KEY, UPDATE_QUEUE_KEY } from "../update/updater.service";
import { ProxyService } from "./proxy.service";
import { AgentEndpointsService, type MoveTarget } from "./agent-endpoints.service";
import type { PanelDomainJob, PanelDomainStatus, RemovePanelDomainInput, SetPanelDomainInput } from "./panel-domain.dto";

export const PANEL_DOMAIN_STATUS_KEY = "instance:panel-domain:status";
/** Written by the updater sidecar while it applies a job: `{jobId, phase: applying|applied|failed, error}`. */
export const PANEL_DOMAIN_UPDATER_KEY = "instance:panel-domain:updater";
const LOCK_KEY = "instance:panel-domain:lock";
const FINALIZE_KEY = "instance:panel-domain:finalize:";
const LOCK_TTL_S = 15 * 60;
const STATUS_TTL_S = 6 * 3600;
const ACTIVE = new Set(["proxy", "certificate", "switching"]);

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
/** The email shape the update helper (scripts/lib/paneldomain.sh pd_valid_email) accepts: checked HERE so an address the
 *  helper would refuse is rejected up front, before anything is saved or configured. */
const HELPER_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

interface StoredJob {
  jobId: string;
  phase: PanelDomainJob["phase"];
  action: "set" | "remove";
  domain: string | null;
  previousDomain: string | null;
  acmeEmail: string | null;
  publicIp: string | null;
  actor: string;
  startedAt: string;
  switchingAt: number | null;
  error: string | null;
  code: PanelDomainJob["code"];
  detail: string | null;
  /** The exact queue payload handed to the updater, kept so a job the hub gives up on can be pulled back out of the queue. */
  queued?: string | null;
}

const IDLE_JOB: PanelDomainJob = { phase: "idle", action: null, domain: null, targetUrl: null, error: null, code: null, detail: null, startedAt: null };

function hostOf(u?: string | null): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Owner-set PANEL DOMAIN (Settings → Instance): what `install.sh --domain` does, from the panel, with no token and no
 * SSH. Safe ORDER — the URL the owner is using today keeps working until the new one is verified:
 *
 *   1. proxy        the local Traefik gets the new host's routers NEXT TO the current ones (the old host or the
 *                   host-less http://<ip>/ route) — via the same ProxyService/agent path a deploy uses.
 *   2. certificate  poll Traefik's ACME store (HTTP-01 first: works through a Cloudflare proxy that forwards :80)
 *                   until the host has a certificate. No certificate in time = ROLLBACK: the pending router is
 *                   dropped, nothing else was touched, the old URL never stopped working.
 *   3. switching    only then is the public URL switched: a job on the update queue (the tugra-updater sidecar, the
 *                   one place with the checkout + docker.sock — the same signed-release scripts the in-app update
 *                   uses) rewrites the .env keys install.sh --domain sets and recreates hub-api + web; a failed
 *                   recreate puts the .env back. The hub never touches its own container or the host.
 *   4. done         the NEW hub process (recreated with the new env) settles the stored domain + the router file.
 *
 * REMOTE AGENTS never get stranded by any of this. Right before the switch (after the certificate / IP route is verified)
 * the new address list — new address first, every current address behind it — is signed and pushed to all connected
 * agents (AgentEndpointsService.beginMove), and the proxy keeps the OLD host / the IP route answering `/agent` for as
 * long as an agent still needs it (until all report the new address, the owner confirms, or 7 days): the panel moves,
 * the agent path stays. A change that fails before the switch re-points the agents at the address that still works.
 *
 * Progress lives in Redis (survives the hub being recreated) and is advanced lazily by status() (the panel polls it)
 * plus a short background watcher.
 */
@Injectable()
export class PanelDomainService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PanelDomainService.name);
  /** Timings (ms); tests shrink them. */
  timing = { certTimeout: 180_000, certPoll: 5_000, ackTimeout: 90_000, applyTimeout: 8 * 60_000, watchPoll: 5_000, settleTries: 6 };
  private runner: Promise<void> | null = null;
  private watching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly agentWs: AgentWsServer,
    private readonly audit: AuditService,
    private readonly settings: InstanceSettingsService,
    private readonly proxy: ProxyService,
    private readonly endpoints: AgentEndpointsService,
  ) {}

  // ---------------------------------------------------------------- reads

  async status(): Promise<PanelDomainStatus> {
    await this.reconcile().catch((e) => this.logger.warn(`reconcile: ${(e as Error).message}`));
    const url = this.config.get<string>("WEB_PUBLIC_URL") ?? null;
    const host = hostOf(url);
    const ipRoute = this.config.get<string>("PANEL_IP_ROUTE")?.trim() === "1";
    const isIp = !!host && (IPV4_RE.test(host) || host.includes(":") || host === "localhost");
    const local = await this.localServer();
    const s = await this.settings.get();
    const job = await this.readJob();
    return {
      mode: !isIp && host ? "domain" : ipRoute ? "ip" : "port",
      domain: !isIp && host ? host : null,
      url,
      ipRoute,
      localServerOnline: local?.status === "ONLINE",
      acmeEmail: (await this.settings.acmeEmailFor(this.config.get<string>("ACME_EMAIL"))) ?? s.acmeEmail ?? null,
      job: job ? this.view(job) : IDLE_JOB,
      agents: await this.endpoints.status().catch(() => null),
    };
  }

  /** Owner: stop waiting for the agents that have not moved yet; the old address stops being routed for them. */
  async releaseAgents(userId: string): Promise<PanelDomainStatus> {
    await this.endpoints.release();
    await this.audit.log({ actor: userId, action: "instance.panel_domain.agents_released", target: "agents" }).catch((e) => this.logger.warn(`audit: ${(e as Error).message}`));
    return this.status();
  }

  // ---------------------------------------------------------------- actions

  /** Start serving the panel on `input.domain`. Idempotent: the host already served, or the same change already
   *  running, just returns the status. */
  async set(userId: string, input: SetPanelDomainInput): Promise<PanelDomainStatus> {
    let domain: string;
    let email: string | undefined;
    try {
      domain = validatePanelDomain(input.domain);
      email = optionalAcmeEmail(input.acmeEmail);
      if (email && (email.length > 320 || !HELPER_EMAIL_RE.test(email))) throw new Error("the email contains characters that are not accepted here — use letters, digits and . _ % + - only");
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    await this.reconcile().catch(() => undefined);
    if (hostOf(this.config.get<string>("WEB_PUBLIC_URL")) === domain) return this.status(); // already served here
    const existing = await this.readJob();
    if (existing && ACTIVE.has(existing.phase)) {
      if (existing.action === "set" && existing.domain === domain) return this.status();
      throw new ConflictException("another panel domain change is already running");
    }
    const local = await this.requireLocalOnline();
    await this.refuseDuringUpdate();
    if (!(await this.redis.firstInWindow(LOCK_KEY, LOCK_TTL_S))) throw new ConflictException("another panel domain change is already running");

    let job: StoredJob;
    try {
      const envEmail = (this.config.get<string>("ACME_EMAIL") ?? "").trim();
      // The owner's email is only a contact for expiry notices. An env-set one (ACME_EMAIL) stays authoritative.
      if (email && !envEmail) await this.settings.update({ acmeEmail: email });
      const effective = envEmail || email || (await this.settings.get()).acmeEmail || null;

      job = this.newJob(userId, "set", domain, effective, null);
      await this.writeJob(job);
    } catch (e) {
      await this.redis.del(LOCK_KEY).catch(() => undefined); // nothing is running: do not leave every retry answering "already running" for 15 minutes
      throw e;
    }
    await this.audit.log({ actor: userId, action: "instance.panel_domain.set", target: domain }).catch((e) => this.logger.warn(`audit: ${(e as Error).message}`));
    this.runner = this.runSet(job, local.id).catch((e) => this.logger.error(`panel-domain run: ${(e as Error).message}`));
    return this.status();
  }

  /** Go back to http://<server-ip>/ (drops the domain). */
  async remove(userId: string, input: RemovePanelDomainInput): Promise<PanelDomainStatus> {
    await this.reconcile().catch(() => undefined);
    const existing = await this.readJob();
    if (existing && ACTIVE.has(existing.phase)) {
      if (existing.action === "remove") return this.status();
      throw new ConflictException("another panel domain change is already running");
    }
    const current = hostOf(this.config.get<string>("WEB_PUBLIC_URL"));
    if (!current || IPV4_RE.test(current) || current.includes(":")) return this.status(); // no domain to remove
    const local = await this.requireLocalOnline();
    const ip = input.publicIp ?? (await this.knownPublicIp(local.id));
    if (!ip || !IPV4_RE.test(ip)) {
      throw new ConflictException("this server's public IP is not known — pass publicIp so the panel URL can go back to http://<ip>/");
    }
    await this.refuseDuringUpdate();
    if (!(await this.redis.firstInWindow(LOCK_KEY, LOCK_TTL_S))) throw new ConflictException("another panel domain change is already running");

    const job = this.newJob(userId, "remove", null, null, ip);
    job.previousDomain = current;
    try {
      await this.writeJob(job);
    } catch (e) {
      await this.redis.del(LOCK_KEY).catch(() => undefined);
      throw e;
    }
    await this.audit.log({ actor: userId, action: "instance.panel_domain.remove", target: current }).catch((e) => this.logger.warn(`audit: ${(e as Error).message}`));
    this.runner = this.runRemove(job, local.id).catch((e) => this.logger.error(`panel-domain run: ${(e as Error).message}`));
    return this.status();
  }

  // ---------------------------------------------------------------- the runs

  private async runSet(job: StoredJob, localId: string): Promise<void> {
    try {
      await this.redis.set(PANEL_PENDING_KEY, JSON.stringify({ domain: job.domain }), PANEL_PENDING_TTL_S);
      await this.advance(job, "proxy");
      await this.proxy.ensureProxy(localId); // new host's routers next to the current ones (self-reconciling, recreates only if needed)
      await this.advance(job, "certificate");
      const cert = await this.waitForCertificate(localId, job.domain as string);
      if (!cert.ok) return await this.fail(job, "cert_timeout", "the certificate was not issued in time", cert.detail);
      await this.moveAgents(job, { kind: "domain", domain: job.domain as string });
      await this.enqueue(job);
    } catch (e) {
      await this.fail(job, "proxy_failed", (e as Error).message || "could not configure the proxy");
    }
  }

  private async runRemove(job: StoredJob, localId: string): Promise<void> {
    try {
      await this.redis.set(PANEL_PENDING_KEY, JSON.stringify({ domain: null }), PANEL_PENDING_TTL_S);
      await this.advance(job, "proxy");
      await this.endpoints.ensureIpTls(job.publicIp); // the IP address answers on :443 with ONE persisted certificate (the agents' pin)
      await this.proxy.ensureProxy(localId); // IP route live next to the current host BEFORE the URLs are switched
      await this.moveAgents(job, { kind: "ip", ip: job.publicIp as string });
      await this.enqueue(job);
    } catch (e) {
      await this.fail(job, "proxy_failed", (e as Error).message || "could not configure the proxy");
    }
  }

  /** Point every connected remote agent at the new address (old one kept behind it) BEFORE the panel switches. */
  private async moveAgents(job: StoredJob, target: MoveTarget): Promise<void> {
    const plan = await this.endpoints.planMove(target);
    const r = await this.endpoints.beginMove(plan);
    this.logger.log(`panel-domain ${job.jobId}: ${r.moved}/${r.total} remote agents already on ${plan.primary.url} before the switch`);
  }

  /** Poll Traefik's ACME store on the local server until `domain` has a certificate (or the deadline passes). */
  private async waitForCertificate(localId: string, domain: string): Promise<{ ok: boolean; detail: string | null }> {
    // `domain` is validatePanelDomain()-clean ([a-z0-9.-] only), so it is safe inside the quoted grep pattern.
    const probe = `for f in /etc/tugra/letsencrypt/acme.json /etc/tugra/letsencrypt/acme-dns.json; do grep -qs '"main": *"${domain}"' "$f" && echo CERT:1 && exit 0; done; echo CERT:0`;
    const deadline = Date.now() + this.timing.certTimeout;
    for (;;) {
      try {
        const r = await this.agentWs.sendCommand(localId, probe, "deploy", 15_000);
        if (/CERT:1/.test(r.output)) return { ok: true, detail: null };
      } catch {
        /* a failed probe is just "not yet" */
      }
      if (Date.now() >= deadline) break;
      await sleep(this.timing.certPoll);
    }
    return { ok: false, detail: await this.proxyLogTail(localId) };
  }

  private async proxyLogTail(localId: string): Promise<string | null> {
    try {
      const r = await this.agentWs.sendCommand(
        localId,
        `docker logs --tail 200 ${PROXY_NAME} 2>&1 | grep -iE 'acme|certificate|unable|obtain' | tail -n 3`,
        "deploy",
        15_000,
      );
      const clean = r.output.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
      return clean || null;
    } catch {
      return null;
    }
  }

  /** Hand the .env + recreate step to the updater sidecar (same queue + signed scripts as an update). */
  private async enqueue(job: StoredJob): Promise<void> {
    const payload = {
      action: "panel-domain",
      jobId: job.jobId,
      domain: job.action === "set" ? job.domain : "",
      acmeEmail: job.acmeEmail ?? "",
      publicIp: job.publicIp ?? "",
      requestedAt: String(Math.floor(Date.now() / 1000)),
    };
    await this.redis.del(PANEL_DOMAIN_UPDATER_KEY);
    // "switching" is recorded BEFORE the job is queued: the updater only applies a job the hub's own record still names in
    // that phase, so it must already say so when the job can first be popped.
    job.queued = JSON.stringify(payload);
    job.switchingAt = Date.now();
    await this.advance(job, "switching");
    await this.redis.client.lpush(UPDATE_QUEUE_KEY, job.queued);
    this.watch();
  }

  // ---------------------------------------------------------------- state machine

  /** Advance a stuck/finished job. Idempotent and safe to call from every poll and from boot. */
  async reconcile(): Promise<void> {
    const job = await this.readJob();
    if (!job || !ACTIVE.has(job.phase)) return;
    if (job.phase !== "switching") {
      // proxy/certificate run inside THIS process; with no live runner (the hub restarted) it is abandoned.
      if (!this.runner && Date.now() - Date.parse(job.startedAt) > this.timing.certTimeout + 60_000) {
        await this.fail(job, "interrupted", "the change was interrupted before the URL was switched");
      }
      return;
    }
    const u = await this.readUpdater(job.jobId);
    const age = Date.now() - (job.switchingAt ?? Date.parse(job.startedAt));
    if (u?.phase === "applied") return this.finalize(job);
    if (u?.phase === "failed") {
      // The helper marks two special outcomes with a prefix on its error text; everything else is a plain failure.
      const m = /^(unreachable|restore_unverified):\s*(.*)$/s.exec(u.error ?? "");
      if (m) return this.fail(job, m[1] as "unreachable" | "restore_unverified", m[2] || "the updater could not apply the change");
      return this.fail(job, "updater_failed", u.error || "the updater could not apply the change");
    }
    if (!u && age > this.timing.ackTimeout) {
      return this.fail(job, "updater_stale", "the update helper did not pick the change up — update it first (Settings → Updates), then retry");
    }
    if (u?.phase === "applying" && age > this.timing.applyTimeout) return this.fail(job, "updater_failed", "applying the change timed out");
  }

  /** The URL was switched and the new hub is up: settle the stored domain and the router file. */
  private async finalize(job: StoredJob): Promise<void> {
    if (!(await this.redis.firstInWindow(FINALIZE_KEY + job.jobId, 600))) return; // another poll is on it
    try {
      await this.settings.update({ panelDomain: job.action === "set" ? job.domain : null });
      await this.redis.del(PANEL_PENDING_KEY);
      await this.endpoints.markSwitched().catch((e) => this.logger.warn(`agent endpoints: ${(e as Error).message}`)); // from here the agent grace may end once everyone moved
      void this.settleProxy(); // the local agent may still be reconnecting after the hub was recreated: retry in the background
      job.phase = "done";
      await this.writeJob(job);
      await this.redis.del(LOCK_KEY);
      await this.audit.log({ actor: job.actor, action: "instance.panel_domain.applied", target: job.domain ?? "ip" });
    } catch (e) {
      this.logger.error(`panel-domain finalize: ${(e as Error).message}`);
      await this.redis.del(FINALIZE_KEY + job.jobId); // let the next poll retry
    }
  }

  /** Re-render the proxy from the settled config (drops the old host / IP route). Retries while the agent reconnects. */
  private async settleProxy(): Promise<void> {
    for (let i = 0; i < this.timing.settleTries; i++) {
      try {
        const local = await this.localServer();
        if (local) await this.proxy.ensureProxy(local.id);
        return;
      } catch (e) {
        this.logger.warn(`panel-domain settle (try ${i + 1}): ${(e as Error).message}`);
        await sleep(this.timing.watchPoll);
      }
    }
  }

  /** ROLLBACK: drop the pending router and report why. Nothing else was changed before the URL switch. */
  private async fail(job: StoredJob, code: NonNullable<PanelDomainJob["code"]>, error: string, detail: string | null = null): Promise<void> {
    job.phase = "failed";
    job.code = code;
    job.error = error;
    job.detail = detail;
    await this.writeJob(job);
    // The hub has given up: a job still waiting in the updater's queue must never be applied late (the updater also
    // refuses one the hub no longer lists as "switching"). Best effort; the updater-side checks are the backstop.
    if (job.queued) await this.redis.client.lrem(UPDATE_QUEUE_KEY, 0, job.queued).catch((e: Error) => this.logger.warn(`panel-domain dequeue: ${e.message}`));
    await this.redis.del(PANEL_PENDING_KEY);
    await this.redis.del(LOCK_KEY);
    await this.redis.del(PANEL_DOMAIN_UPDATER_KEY);
    // Agents may already be on the new address: point them back at the one that still works BEFORE its router is dropped.
    await this.endpoints.cancelMove().catch((e) => this.logger.warn(`panel-domain agents rollback: ${(e as Error).message}`));
    // Re-render the proxy WITHOUT the pending host (best effort: a failed settle leaves a harmless extra router that
    // the next reconcile removes; the old URL works either way).
    const local = await this.localServer();
    if (local) await this.proxy.ensureProxy(local.id).catch((e) => this.logger.warn(`panel-domain rollback: ${(e as Error).message}`));
    await this.audit.log({ actor: job.actor, action: "instance.panel_domain.failed", target: job.domain ?? "ip" }).catch(() => undefined);
  }

  /** Keep reconciling for a while after a switch is queued (the panel may be closed). Bounded, unref'd. */
  private watch(): void {
    if (this.watching) return;
    this.watching = true;
    const until = Date.now() + this.timing.ackTimeout + this.timing.applyTimeout + 60_000;
    const tick = async () => {
      try {
        await this.reconcile();
        const j = await this.readJob();
        if (!j || !ACTIVE.has(j.phase) || Date.now() > until) {
          this.watching = false;
          return;
        }
      } catch {
        /* keep watching */
      }
      setTimeout(tick, this.timing.watchPoll).unref?.();
    };
    setTimeout(tick, this.timing.watchPoll).unref?.();
  }

  /** Resume after a hub restart (the updater recreates this process mid-change). */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const job = await this.readJob();
      if (job && job.phase === "switching") this.watch();
    } catch {
      /* Redis not up yet: the panel's poll drives reconcile() anyway */
    }
  }

  // ---------------------------------------------------------------- helpers

  private newJob(actor: string, action: "set" | "remove", domain: string | null, acmeEmail: string | null, publicIp: string | null): StoredJob {
    return {
      jobId: randomUUID(),
      phase: "proxy",
      action,
      domain,
      previousDomain: hostOf(this.config.get<string>("WEB_PUBLIC_URL")),
      acmeEmail,
      publicIp,
      actor,
      startedAt: new Date().toISOString(),
      switchingAt: null,
      error: null,
      code: null,
      detail: null,
    };
  }

  private async advance(job: StoredJob, phase: PanelDomainJob["phase"]): Promise<void> {
    job.phase = phase;
    await this.writeJob(job);
  }

  private view(j: StoredJob): PanelDomainJob {
    // Where the panel is moving to: https://<domain> for a set, http://<ip> for a remove (never the address being left).
    const targetUrl = j.action === "set" && j.domain ? `https://${j.domain}` : j.action === "remove" && j.publicIp ? `http://${j.publicIp}` : null;
    return { phase: j.phase, action: j.action, domain: j.domain, targetUrl, error: j.error, code: j.code, detail: j.detail, startedAt: j.startedAt };
  }

  private async writeJob(j: StoredJob): Promise<void> {
    await this.redis.set(PANEL_DOMAIN_STATUS_KEY, JSON.stringify(j), STATUS_TTL_S);
  }

  private async readJob(): Promise<StoredJob | null> {
    const raw = await this.redis.get(PANEL_DOMAIN_STATUS_KEY);
    if (!raw) return null;
    try {
      const j = JSON.parse(raw) as StoredJob;
      return j && typeof j.jobId === "string" && typeof j.phase === "string" ? j : null;
    } catch {
      return null;
    }
  }

  private async readUpdater(jobId: string): Promise<{ phase: string; error: string | null } | null> {
    const raw = await this.redis.get(PANEL_DOMAIN_UPDATER_KEY);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as { jobId?: unknown; phase?: unknown; error?: unknown };
      if (p.jobId !== jobId || typeof p.phase !== "string") return null;
      return { phase: p.phase, error: typeof p.error === "string" && p.error ? p.error : null };
    } catch {
      return null;
    }
  }

  private async localServer() {
    return this.prisma.server.findFirst({ where: { isLocal: true }, select: { id: true, status: true, publicIp: true } }).catch(() => null);
  }

  private async requireLocalOnline(): Promise<{ id: string }> {
    const local = await this.localServer();
    if (!local) throw new BadRequestException("no local server to host the panel");
    if (local.status !== "ONLINE") throw new ConflictException("the local server is offline — start it and retry");
    return local;
  }

  private async knownPublicIp(localId: string): Promise<string | null> {
    const fromEnv = (this.config.get<string>("LOCAL_SERVER_PUBLIC_IP") ?? "").trim();
    if (IPV4_RE.test(fromEnv)) return fromEnv;
    const row = await this.prisma.server.findUnique({ where: { id: localId }, select: { publicIp: true } }).catch(() => null);
    return row?.publicIp && IPV4_RE.test(row.publicIp) ? row.publicIp : null;
  }

  private async refuseDuringUpdate(): Promise<void> {
    if (await this.redis.get(UPDATE_LOCK_KEY)) throw new ConflictException("an update is running — wait for it to finish");
  }
}
