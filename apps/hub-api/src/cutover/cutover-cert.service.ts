import { BadRequestException, ConflictException, Injectable, PayloadTooLargeException, UnsupportedMediaTypeException } from "@nestjs/common";
import { X509Certificate } from "node:crypto";
import type { Readable } from "node:stream";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ProxyService } from "../applications/proxy.service";
import { ImportExecutorService } from "../importer/import-executor.service";
import type { MigrationTokenContext } from "../importer/migration-token.service";
import { buildAcmeReadScript, buildAcmeWriteScript, parseAcmeReadOutput, parseAcmeSeedOutput } from "./cutover-scripts";
import { certNames, keyMatchesCert, MIN_SEED_DAYS, mergeAcmeStore, sanitizeText, type SeedCert } from "./cutover.logic";
import type { CutoverSeedCertsInput } from "./cutover.dto";

export const CERTS_MAX_BODY = 2 * 1024 * 1024;
export const CERTS_MAX_COUNT = 500;
export const CERT_PEM_MAX = 64 * 1024;
export const WANTED_MAX = 500;

export type CertReject = "expired" | "key-mismatch" | "no-matching-app" | "malformed" | "too-large";

type IngestReq = Readable & { headers: Record<string, string | string[] | undefined> };

/** True when `name` (possibly a `*.zone` wildcard) covers `host`. */
export function nameCovers(name: string, host: string): boolean {
  if (name === host) return true;
  if (name.startsWith("*.")) {
    const rest = name.slice(2);
    return host.endsWith(`.${rest}`) && host.slice(0, -rest.length - 1).split(".").length === 1;
  }
  return false;
}

/**
 * Opt-in transfer of the source host's own ACME certificates (`tugra-agent migrate --certs`), for zones Tugra cannot
 * pre-issue DNS-01 certificates in. Staging changes nothing live: a staged certificate serves no traffic until
 * {@link seed} merges it into the target proxy's OWN acme.json (so Traefik keeps renewing it). Private keys are
 * encrypted at rest with the cert store's CryptoService, never logged, and the ciphertext is blanked once applied.
 */
@Injectable()
export class CutoverCertService {
  private readonly serverLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly access: TeamAccessService,
    private readonly agentWs: AgentWsServer,
    private readonly proxy: ProxyService,
    private readonly executor: ImportExecutorService,
  ) {}

  /** The hostnames this op's imported apps serve (primary, aliases, compose service domains). Hub-derived from the
   *  op's DONE app tasks: the source host's claims are never trusted. Capped. */
  async wanted(op: MigrationTokenContext): Promise<{ hosts: string[] }> {
    await this.executor.loadIngestOp(op.opId, op.actorId);
    return { hosts: [...(await this.wantedSet(op.opId))].sort().slice(0, WANTED_MAX) };
  }

  private async wantedSet(opId: string): Promise<Set<string>> {
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: "app", status: "DONE", resourceType: "application" }, select: { resourceId: true } });
    const ids = tasks.map((t) => t.resourceId).filter((x): x is string => !!x);
    const apps = await this.prisma.application.findMany({ where: { id: { in: ids } }, select: { id: true, domain: true, extraDomains: true } });
    const svc = await this.prisma.appServiceDomain.findMany({ where: { applicationId: { in: ids } }, select: { hostname: true } });
    const out = new Set<string>();
    for (const a of apps) {
      if (a.domain) out.add(a.domain.toLowerCase());
      for (const h of a.extraDomains ?? []) out.add(h.toLowerCase());
    }
    for (const s of svc) out.add(s.hostname.toLowerCase());
    return out;
  }

  /** Read the (raw octet-stream) body with a hard cap — the global JSON parser's small limit never sees it. */
  private async readBody(req: IngestReq): Promise<Buffer> {
    const ctype = String(req.headers["content-type"] ?? "");
    if (!ctype.includes("application/octet-stream")) throw new UnsupportedMediaTypeException("expected application/octet-stream");
    const len = Number(req.headers["content-length"]);
    if (Number.isFinite(len) && len > CERTS_MAX_BODY) throw new PayloadTooLargeException("certificate bundle exceeds the 2 MiB cap");
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c as string);
      n += b.length;
      if (n > CERTS_MAX_BODY) throw new PayloadTooLargeException("certificate bundle exceeds the 2 MiB cap");
      chunks.push(b);
    }
    return Buffer.concat(chunks);
  }

  /** Validate + encrypt + upsert each certificate. The response carries counts and fixed reason codes only. */
  async stage(op: MigrationTokenContext, req: IngestReq): Promise<{ accepted: number; rejected: Array<{ main: string; reason: CertReject }> }> {
    await this.executor.loadIngestOp(op.opId, op.actorId);
    const raw = await this.readBody(req);
    let body: { certs?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8")) as { certs?: unknown };
    } catch {
      throw new BadRequestException("the body is not valid JSON");
    }
    if (!Array.isArray(body.certs)) throw new BadRequestException("certs must be an array");
    if (body.certs.length > CERTS_MAX_COUNT) throw new PayloadTooLargeException("too many certificates");
    const wanted = await this.wantedSet(op.opId);
    const rejected: Array<{ main: string; reason: CertReject }> = [];
    let accepted = 0;
    const now = Date.now();
    for (const item of body.certs as Array<Record<string, unknown>>) {
      const main = typeof item?.main === "string" ? item.main.trim().toLowerCase() : "";
      const reject = (reason: CertReject) => rejected.push({ main: sanitizeText(main, 120), reason });
      const certPem = item?.certPem;
      const keyPem = item?.keyPem;
      const sansIn = Array.isArray(item?.sans) ? (item.sans as unknown[]).filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase()) : [];
      if (!main || typeof certPem !== "string" || typeof keyPem !== "string" || !/^(\*\.)?[a-z0-9.-]{1,253}$/.test(main)) {
        reject("malformed");
        continue;
      }
      if (certPem.length > CERT_PEM_MAX || keyPem.length > CERT_PEM_MAX) {
        reject("too-large");
        continue;
      }
      let x: X509Certificate;
      try {
        x = new X509Certificate(certPem);
      } catch {
        reject("malformed");
        continue;
      }
      const names = certNames(certPem);
      if (!names.some((n) => nameCovers(n, main))) {
        reject("malformed");
        continue;
      }
      if (Date.parse(x.validTo) < now) {
        reject("expired");
        continue;
      }
      if (!keyMatchesCert(certPem, keyPem)) {
        reject("key-mismatch");
        continue;
      }
      const hosts = [...new Set([main, ...sansIn, ...names])];
      if (![...wanted].some((w) => hosts.some((h) => nameCovers(h, w)))) {
        reject("no-matching-app");
        continue;
      }
      const fingerprint = x.fingerprint256.replace(/:/g, "").toLowerCase();
      const data = { hosts, certPem, keyEnc: this.crypto.encrypt(keyPem), notBefore: new Date(x.validFrom), notAfter: new Date(x.validTo) };
      await this.prisma.cutoverCert.upsert({
        where: { opId_fingerprint: { opId: op.opId, fingerprint } },
        create: { opId: op.opId, fingerprint, ...data },
        // A re-run of the migrator re-sends the same cert: refresh it, but never resurrect an already-applied (purged) key.
        update: { hosts, certPem, notBefore: data.notBefore, notAfter: data.notAfter },
      });
      accepted++;
    }
    await this.audit.log({ actor: op.actorId, action: "cutover.seedCerts.stage", target: op.opId, meta: { accepted, rejected: rejected.length } }).catch(() => undefined);
    return { accepted, rejected };
  }

  /** Merge the staged certificates into each target server's own acme.json (stops the proxy first, ALWAYS recreates it). */
  async seed(userId: string, opId: string, input: CutoverSeedCertsInput): Promise<{ applied: number }> {
    await this.executor.ownedOpForCutover(userId, opId);
    const certs = await this.prisma.cutoverCert.findMany({ where: { opId, appliedAt: null, NOT: { keyEnc: "" } } });
    if (certs.length === 0) throw new ConflictException("no staged certificates to apply (run the migrator with --certs first)");
    const entries = await this.prisma.cutoverDomain.findMany({ where: { opId }, select: { hostname: true, applicationId: true, state: true } });
    const apps = await this.prisma.application.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.applicationId))] } }, select: { id: true, teamId: true, serverId: true, clusterId: true } });
    const appById = new Map(apps.map((a) => [a.id, a]));
    for (const t of new Set(apps.map((a) => a.teamId))) await this.access.requirePermission(userId, t, "apps:config");

    // server -> certs that cover one of its hosts
    const byServer = new Map<string, Set<string>>();
    const liveByServer = new Map<string, boolean>();
    for (const e of entries) {
      const a = appById.get(e.applicationId);
      if (!a) continue;
      if (a.clusterId) throw new ConflictException("seeding is not supported for a clustered app");
      if (input.serverId && a.serverId !== input.serverId) continue;
      for (const c of certs) {
        if (c.hosts.some((h) => nameCovers(h, e.hostname))) byServer.set(a.serverId, new Set([...(byServer.get(a.serverId) ?? []), c.id]));
      }
      if (e.state === "SWITCHED" || e.state === "VERIFIED") liveByServer.set(a.serverId, true);
    }
    if (byServer.size === 0) throw new ConflictException("none of the staged certificates covers a host of this operation");
    for (const sid of byServer.keys()) {
      const srv = await this.prisma.server.findUnique({ where: { id: sid }, select: { swarmRole: true } });
      if (srv?.swarmRole) throw new ConflictException("seeding is not supported on a swarm node");
      if (liveByServer.get(sid) && !input.acknowledgeProxyRestart) throw new ConflictException("live hosts are already switched to this server: acknowledgeProxyRestart is required (the proxy restarts and ingress drops for every app on it)");
      if (!input.acknowledgeProxyRestart) throw new ConflictException("acknowledgeProxyRestart is required: the proxy restarts for a few seconds and ingress drops for every app on that server");
    }
    const appliedCertIds = new Set<string>();
    for (const [sid, ids] of byServer) {
      const mine = certs.filter((c) => ids.has(c.id));
      await this.withServerLock(sid, async () => {
        const seeds: SeedCert[] = mine.map((c) => ({ main: c.hosts[0], sans: c.hosts.slice(1), certPem: c.certPem, keyPem: this.crypto.decrypt(c.keyEnc) }));
        try {
          const read = await this.agentWs.sendCommand(sid, buildAcmeReadScript(), "deploy", 30_000);
          const parsed = parseAcmeReadOutput(read.output);
          if (!parsed || parsed.tooBig) throw new ConflictException("the target acme.json could not be read (missing or too large)");
          const existing = parsed.b64 ? Buffer.from(parsed.b64, "base64").toString("utf8") : null;
          const merged = mergeAcmeStore(existing, seeds, "le");
          const b64 = Buffer.from(merged.json, "utf8").toString("base64");
          const w = await this.agentWs.sendCommand(sid, buildAcmeWriteScript(b64, merged.added), "deploy", 30_000);
          if (w.exitCode !== 0 || parseAcmeSeedOutput(w.output) === null) throw new ConflictException("writing acme.json on the target failed");
          for (const c of mine) appliedCertIds.add(c.id);
        } finally {
          // The proxy is never left stopped: a hot write would be clobbered (Traefik rewrites the whole file), so it
          // was stopped first and is ALWAYS recreated here, even when a step above failed.
          await this.proxy.ensureProxy(sid, { force: true }).catch(() => undefined);
        }
      });
    }
    const now = new Date();
    for (const id of appliedCertIds) {
      const sid = [...byServer.entries()].find(([, ids]) => ids.has(id))?.[0] ?? null;
      await this.prisma.cutoverCert.update({ where: { id }, data: { keyEnc: "", appliedAt: now, appliedServerId: sid } });
    }
    await this.audit.log({ actor: userId, action: "cutover.seedCerts", target: opId, meta: { applied: appliedCertIds.size, servers: byServer.size, minDays: MIN_SEED_DAYS } }).catch(() => undefined);
    return { applied: appliedCertIds.size };
  }

  /** Purge every staged private key of an op (op rollback / cleanup). Rows cascade-delete with the op itself. */
  async purge(opId: string): Promise<void> {
    await this.prisma.cutoverCert.updateMany({ where: { opId }, data: { keyEnc: "" } });
  }

  private async withServerLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.serverLocks.get(sid) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.serverLocks.set(sid, run.catch(() => undefined));
    return run;
  }
}
