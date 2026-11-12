import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ProxyConfigService } from "../proxy-config/proxy-config.service";
import { buildProxySetupScript } from "../deploy/deploy-script";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** Per-server reconcile state: the single shared deferred that trailing callers (those arriving while a
 *  reconcile is already running) await. When the in-flight pass settles, an accumulated cohort is promoted to
 *  exactly ONE more reconcile of the final desired state. */
interface Flight {
  trailing?: Deferred;
}

/** Ensures the Traefik reverse-proxy is running on a server (idempotent, self-healing, coalesced). */
@Injectable()
export class ProxyService {
  // Per-serverId single-flight-WITH-trailing coalescer (in-process; the hub is single-instance — the deploy
  // queue itself relies on Postgres row locks for one hub). A burst of concurrent domained deploys on one
  // server collapses to the in-flight reconcile + ONE trailing reconcile of the FINAL desired state, so it
  // never fans out to N recreates and the last config change is never dropped. The agent-side hash gate then
  // makes an unchanged burst a zero-drop no-op. Not cluster-safe by design, but the agent-side label reconcile
  // is idempotent, so even two racing hubs would at worst double-recreate, never corrupt.
  private readonly flights = new Map<string, Flight>();

  constructor(
    private readonly agentWs: AgentWsServer,
    private readonly prisma: PrismaService,
    private readonly proxyConfig: ProxyConfigService,
  ) {}

  /**
   * Ensure the Traefik reverse-proxy is running on `serverId` (idempotent + self-healing). Coalesced per
   * server: concurrent calls during an in-flight reconcile collapse to one trailing reconcile that re-reads
   * fresh DB state, so a deploy burst never triggers N recreates and the last config change is never dropped.
   * Every caller still awaits a real pass/fail (the throw-on-nonzero contract is preserved for all awaiters of
   * a cycle). `force` (an explicit operator recreate) bypasses BOTH the coalescer and the agent-side skip gate
   * — it rebuilds immediately and unconditionally.
   */
  async ensureProxy(serverId: string, opts: { force?: boolean } = {}): Promise<void> {
    if (opts.force) {
      // Operator action (rare + explicit): run now, bypass the coalescer. It can race a coalesced reconcile on
      // the same agent (two docker rm/run) — the agent-side hash gate keeps that from corrupting state, but the
      // loser may fail loudly (a transient), the same class of race that pre-dated this coalescer when every
      // domained deploy recreated unconditionally. Acceptable for an infrequent operator action.
      return this.runReconcile(serverId, true);
    }

    const flight = this.flights.get(serverId);
    if (flight) {
      // A reconcile is already running for this server — join the single trailing cohort and await it. The
      // trailing pass re-runs resolveFor, so everyone in the cohort gets the FINAL desired state (pass or fail).
      if (!flight.trailing) flight.trailing = makeDeferred();
      return flight.trailing.promise;
    }

    // No in-flight pass — become the leader. Register the entry FIRST so callers arriving during this pass
    // join the trailing cohort rather than each starting their own leader pass.
    const self: Flight = {};
    this.flights.set(serverId, self);
    let err: unknown;
    let threw = false;
    try {
      await this.runReconcile(serverId, false);
    } catch (e) {
      err = e;
      threw = true;
    }
    // Hand the entry to the drain loop (promote any trailing cohort to one more pass, else clear it), then
    // return this leader's OWN result. The drain proceeds independently, so a trailing cohort still gets a
    // fresh pass even when the leader's pass threw.
    this.drain(serverId, self);
    if (threw) throw err;
  }

  /** Promote the accumulated trailing cohort (if any) to ONE more reconcile and settle its deferred with that
   *  pass's result; recurse for callers that arrive during it. When no cohort is waiting, clear the per-server
   *  entry so the next caller becomes a fresh leader — no stuck state, even after a thrown pass. */
  private drain(serverId: string, flight: Flight): void {
    const cohort = flight.trailing;
    if (!cohort) {
      this.flights.delete(serverId);
      return;
    }
    // Consume this cohort; callers arriving during the pass below accumulate into a FRESH trailing deferred.
    flight.trailing = undefined;
    this.runReconcile(serverId, false).then(
      () => {
        cohort.resolve();
        this.drain(serverId, flight);
      },
      (e) => {
        cohort.reject(e);
        this.drain(serverId, flight);
      },
    );
  }

  /** One reconcile pass: resolve the proxy config fresh (single source of truth: ProxyConfigService) and send
   *  the conditional (unless `force`) setup script. Refuses on a swarm-manager host and throws on a non-zero
   *  agent exit, so a failure never looks like a successful deploy. */
  private async runReconcile(serverId: string, force: boolean): Promise<void> {
    // Coexistence guard: a swarm manager runs the swarm-mode Traefik on :80/:443. Standing up the classic
    // per-server proxy here would collide (a later `docker run -p 80:80` fails loudly, or worse silently
    // half-works). Refuse — this server is dedicated to swarm ingress.
    const swarmManaged = await this.prisma.cluster.count({
      where: { swarmManagerId: serverId, swarmStatus: { in: ["ACTIVE", "DEGRADED", "FORMING", "DISSOLVING"] } },
    });
    if (swarmManaged > 0) {
      throw new BadRequestException(
        "this server is a swarm manager (it runs the cluster's swarm ingress on :80/:443) — domain-routed single-server apps can't be deployed directly here",
      );
    }
    // Single source of truth (ProxyConfigService): email, bind mode, DNS-01 creds AND — for the local server —
    // the panel router. The resulting script is self-reconciling: unless `force`, it skips (zero drop) when the
    // running proxy already carries this exact config hash, and only recreates on a real proxy-level change or
    // to self-heal an absent/unhealthy container.
    const cfg = await this.proxyConfig.resolveFor(serverId);
    const r = await this.agentWs.sendCommand(
      serverId,
      buildProxySetupScript({
        acmeEmail: cfg.acmeEmail,
        bind: cfg.bind,
        dnsProvider: cfg.dnsProvider,
        dnsCreds: cfg.dnsCreds,
        panel: cfg.panel,
        accessLog: cfg.accessLog,
        force,
      }),
      "deploy",
      60_000,
    );
    // On fall-through the setup script does `docker rm -f tugra-proxy` BEFORE `docker run`, so a failed re-run
    // (port taken, docker error) leaves NO proxy and every routed app on this server down. Never let that pass
    // as a successful deploy — surface it so the caller fails loudly.
    if (r.exitCode !== 0) {
      throw new BadRequestException(`reverse-proxy (Traefik) setup failed on this server: ${r.output.trim().slice(-500)}`);
    }
  }
}

function makeDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
