import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { TeamPermission } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CloudflareApiClient, type DnsRecord } from "../tunnel/cloudflare-api.client";
import { SwarmProxyService } from "../clusters/swarm-proxy.service";
import { isAlwaysBlockedIp, isIpv6, isPublicIp } from "../common/observed-ip";
import { DnsCredentialsService } from "./dns-credentials.service";
import { DnsLookupService } from "./dns-lookup.service";
import { caaAllowsLetsEncrypt, stepAction, type LedgerRecord, type ProviderRec } from "../cutover/cutover.logic";

/**
 * A planned DNS record and what applying it will do:
 *  - "noop": an existing record already has this exact content AND is DNS-only (proxied=false) — leave it.
 *  - "update": reuse an existing record's id and PUT it (adopt a content-match that was proxied, or — only with
 *    overwrite — repoint a foreign record to our content).
 *  - "create": POST a brand-new record (no existing one to reuse).
 *  - "delete": remove a conflicting/surplus record (only ever planned WITH overwrite).
 *  - "conflict": an existing record points somewhere else (different content) or is a type-incompatible record at
 *    the same name; applying would clobber it, so it is surfaced and apply refuses unless overwrite is set.
 */
export interface PlannedRecord {
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  action: "create" | "update" | "noop" | "delete" | "conflict";
  existingId: string | null;
}

export interface DomainPlan {
  hostname: string;
  apex: boolean;
  zoneId: string;
  zoneName: string;
  sslMode: string;
  credentialId: string;
  records: PlannedRecord[];
}

export interface AppliedRecord {
  type: string;
  name: string;
  recordId: string;
  action: "created" | "updated" | "kept" | "deleted";
}

export interface DomainApplyResult {
  hostname: string;
  apex: boolean;
  status: string;
  records: AppliedRecord[];
}

export interface DomainVerifyResult {
  hostname: string;
  status: string;
  expected: { a: string[]; aaaa: string[] };
  resolved: { a: string[]; aaaa: string[] };
  lastError: string | null;
}

interface AppRow {
  id: string;
  teamId: string;
  serverId: string;
  clusterId: string | null;
  domain: string | null;
}

interface OwnedRecord {
  type: string;
  name: string;
  recordId: string;
  // true only when Tugra CREATED this record (action "created"). A record we merely kept (noop on a record the
  // user already had) or adopted/repointed (update) is NOT ours to delete — cleanup leaves those untouched.
  created?: boolean;
}

interface PreviewInput {
  domain: string;
  credentialId?: string;
  includeWww?: boolean;
  overwrite?: boolean;
}

// hostname: 1–253 chars, dotted labels of a-z/0-9/hyphen, a non-numeric TLD. Lowercased, no scheme/port/wildcard.
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * One-click custom-domain DNS auto-setup (v1: Cloudflare). Resolves the app's reachable public IP(s) (the
 * single server's, or a cluster's ingress pool — one A record per node for failover), finds the matching
 * Cloudflare zone with a team DNS credential, and creates DNS-only (proxied=false — avoids the Flexible-SSL
 * :80→:443 redirect loop) A/AAAA records for the apex plus an optional www CNAME. It is CONSERVATIVE with a
 * user's existing zone: a pre-existing record that points elsewhere, or a type-incompatible record at the same
 * name, is a "conflict" that apply refuses to touch unless `overwrite` is explicitly set — so the one click
 * never silently takes down an unrelated site. previewRecords plans without writing; applyRecords writes +
 * records what it owns on a Domain row (merging prior ownership) so records can be cleaned up later; verify
 * does a real public-DNS lookup. Wiring the app's domain/https fields + the www↔apex redirect is the REST
 * layer's job, not this service's.
 */
@Injectable()
export class DnsAutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly cf: CloudflareApiClient,
    private readonly swarmProxy: SwarmProxyService,
    private readonly creds: DnsCredentialsService,
    private readonly lookup: DnsLookupService,
  ) {}

  async previewRecords(userId: string, appId: string, input: PreviewInput): Promise<DomainPlan> {
    const { plan } = await this.plan(userId, appId, input);
    return plan;
  }

  async applyRecords(userId: string, appId: string, input: PreviewInput): Promise<DomainApplyResult> {
    const { token, plan } = await this.plan(userId, appId, input);
    const conflicts = plan.records.filter((r) => r.action === "conflict");
    if (conflicts.length) {
      throw new ConflictException(
        `these existing DNS records conflict with the auto-setup — re-run with overwrite to replace them: ${conflicts
          .map((c) => `${c.type} ${c.name} → ${c.content}`)
          .join(", ")}`,
      );
    }
    const owned: AppliedRecord[] = [];
    const deletedIds: string[] = [];
    try {
      for (const r of plan.records) {
        if (r.action === "noop") {
          owned.push({ type: r.type, name: r.name, recordId: r.existingId!, action: "kept" });
        } else if (r.action === "update") {
          const { recordId } = await this.cf.upsertDnsRecord(token, plan.zoneId, {
            type: r.type, name: r.name, content: r.content, proxied: r.proxied, existingRecordId: r.existingId,
          });
          owned.push({ type: r.type, name: r.name, recordId, action: "updated" });
        } else if (r.action === "create") {
          const { recordId } = await this.cf.createDnsRecord(token, plan.zoneId, {
            type: r.type, name: r.name, content: r.content, proxied: r.proxied,
          });
          owned.push({ type: r.type, name: r.name, recordId, action: "created" });
        } else if (r.action === "delete") {
          await this.cf.deleteDnsRecord(token, plan.zoneId, r.existingId!);
          deletedIds.push(r.existingId!);
          owned.push({ type: r.type, name: r.name, recordId: r.existingId!, action: "deleted" });
        }
      }
    } catch (e) {
      // A partial failure must not orphan the records we DID write: persist them (so cleanup can find them),
      // mark the domain errored, then rethrow so the caller sees the failure.
      const lastError = e instanceof Error ? e.message : "dns apply failed";
      await this.persistDomain(appId, plan, input, owned, deletedIds, "error", lastError);
      throw e;
    }
    await this.persistDomain(appId, plan, input, owned, deletedIds, "pending", null);
    const counts = {
      created: owned.filter((r) => r.action === "created").length,
      updated: owned.filter((r) => r.action === "updated").length,
      deleted: owned.filter((r) => r.action === "deleted").length,
    };
    await this.audit.log({ actor: userId, action: "dns.autosetup.apply", target: appId, meta: { hostname: plan.hostname, zoneId: plan.zoneId, ...counts } });
    return { hostname: plan.hostname, apex: plan.apex, status: "pending", records: owned };
  }

  async verify(userId: string, appId: string, hostname?: string): Promise<DomainVerifyResult> {
    const app = await this.resolveApp(userId, appId, "apps:config");
    const domain = hostname
      ? await this.prisma.domain.findUnique({ where: { applicationId_hostname: { applicationId: appId, hostname: this.normalizeHostname(hostname) } } })
      : await this.prisma.domain.findFirst({ where: { applicationId: appId }, orderBy: { createdAt: "desc" } });
    if (!domain) throw new NotFoundException("no auto-setup domain for this application");
    const expected = await this.resolveTargetIps(app);
    // Side-effect-free: a live public-DNS lookup that RETURNS the status, with no DB write and no audit entry, so it
    // is an honest read (safe for a read-scope token / looping agent to call without mutating or flooding anything).
    try {
      const [a, aaaa] = await Promise.all([this.lookup.resolve4(domain.hostname), this.lookup.resolve6(domain.hostname)]);
      const v4ok = expected.v4.length > 0 && expected.v4.every((ip) => a.includes(ip));
      const v6ok = expected.v6.length === 0 || expected.v6.every((ip) => aaaa.includes(ip));
      const status = v4ok && v6ok ? "active" : "pending";
      return { hostname: domain.hostname, status, expected: { a: expected.v4, aaaa: expected.v6 }, resolved: { a, aaaa }, lastError: null };
    } catch (e) {
      const lastError = e instanceof Error ? e.message : "dns lookup failed";
      return { hostname: domain.hostname, status: "error", expected: { a: expected.v4, aaaa: expected.v6 }, resolved: { a: [], aaaa: [] }, lastError };
    }
  }

  /**
   * The DNS records an operator should create by hand at ANY provider (the copy-paste fallback when they do not
   * use Cloudflare, or want to do it themselves): the apex/host A (+AAAA) records pointing at the app's reachable
   * public IP(s) and an optional www CNAME. No provider call, no zone lookup — advisory only (apps:config). www
   * is a suggestion the operator applies only if the hostname is their zone apex.
   */
  async manualRecords(userId: string, appId: string, input: { domain: string; includeWww?: boolean }): Promise<{ hostname: string; records: Array<{ type: string; name: string; content: string }> }> {
    const app = await this.resolveApp(userId, appId, "apps:config");
    const hostname = this.normalizeHostname(input.domain);
    const targetIps = await this.resolveTargetIps(app);
    if (targetIps.v4.length === 0) {
      throw new BadRequestException("the app's server/cluster has no public IPv4 address to point DNS at");
    }
    const records: Array<{ type: string; name: string; content: string }> = [];
    for (const ip of targetIps.v4) records.push({ type: "A", name: hostname, content: ip });
    for (const ip of targetIps.v6) records.push({ type: "AAAA", name: hostname, content: ip });
    if (input.includeWww ?? true) records.push({ type: "CNAME", name: `www.${hostname}`, content: hostname });
    return { hostname, records };
  }

  /**
   * Delete the Cloudflare records Tugra created for this app's domain(s) and drop the Domain row(s) — the
   * teardown half of auto-setup, for when a custom domain is removed or an app is deleted. apps:deploy. Each
   * record delete is best-effort (an already-gone record is fine); the row is dropped even if the credential is
   * no longer usable, so a stuck credential can't leave an un-droppable row.
   */
  async cleanup(userId: string, appId: string, hostname?: string): Promise<{ removed: number; failed: number }> {
    await this.resolveApp(userId, appId, "apps:deploy");
    return this.purgeDomains(userId, appId, hostname);
  }

  /**
   * Best-effort teardown given the caller is ALREADY authorized for the app (e.g. app deletion). Never throws.
   * Deletes ONLY the records Tugra created (never a record the user already had that we merely kept/adopted). The
   * Domain row — the ownership ledger — is dropped ONLY when every owned record was removed (or was already gone);
   * if any delete fails, or the credential can't be resolved, the row is kept with an error status so the ledger
   * survives for a retry, and the leftover record ids are audited for recovery.
   */
  async purgeDomains(userId: string, appId: string, hostname?: string): Promise<{ removed: number; failed: number }> {
    const where = hostname ? { applicationId: appId, hostname: this.normalizeHostname(hostname) } : { applicationId: appId };
    const domains = await this.prisma.domain.findMany({ where }).catch(() => []);
    let removed = 0;
    let failed = 0;
    for (const d of domains) {
      const recs: OwnedRecord[] = Array.isArray(d.recordIds) ? (d.recordIds as unknown as OwnedRecord[]) : [];
      const owned = recs.filter((r) => r.created); // never delete a pre-existing (kept/adopted) record
      const leftover: string[] = [];
      let removedHere = 0;
      if (owned.length && d.dnsCredentialId && d.zoneId) {
        let token: string | null = null;
        try {
          token = (await this.creds.resolveToken(userId, d.dnsCredentialId)).token;
        } catch {
          token = null; // credential deleted or caller lacks `integrations`
        }
        if (token) {
          for (const r of owned) {
            // deleteDnsRecord already tolerates a 404 (already gone) — a throw here is a real failure (429/5xx/timeout).
            try {
              await this.cf.deleteDnsRecord(token, d.zoneId, r.recordId);
              removedHere++;
            } catch {
              leftover.push(r.recordId);
            }
          }
        } else {
          leftover.push(...owned.map((r) => r.recordId));
        }
      }
      removed += removedHere;
      failed += leftover.length;
      if (leftover.length === 0) {
        await this.prisma.domain.delete({ where: { id: d.id } }).catch(() => undefined);
      } else {
        // Keep the ledger so a retry can finish the job (on app deletion the cascade still removes the row, but the
        // audit entry below preserves the leftover ids for recovery).
        await this.prisma.domain
          .update({ where: { id: d.id }, data: { status: "error", lastError: `${leftover.length} DNS record(s) could not be removed`, lastCheckedAt: new Date() } })
          .catch(() => undefined);
      }
      await this.audit
        .log({ actor: userId, action: "dns.autosetup.cleanup", target: appId, meta: { hostname: d.hostname, removed: removedHere, failed: leftover.length, leftover } })
        .catch(() => undefined);
    }
    return { removed, failed };
  }

  // ── cutover primitives (SSL/DNS cutover of imported apps; the existing auto-setup above is untouched) ──

  /** Read-only: the Cloudflare zone (and its SSL mode) a hostname lives in under a team credential, or null when
   *  the credential cannot see one. Other API errors (bad token, 429) propagate — never reported as "no zone". */
  async findZoneFor(userId: string, credentialId: string, hostname: string): Promise<{ zoneId: string; zoneName: string; apex: boolean; sslMode: string } | null> {
    const c = await this.creds.resolveToken(userId, credentialId);
    if (c.provider !== "cloudflare") throw new BadRequestException("only the cloudflare provider is supported");
    try {
      const { zoneId, zoneName } = await this.cf.findZoneForHostname(c.token, this.normalizeHostname(hostname), c.cfAccountId);
      const sslMode = await this.cf.getZoneSslMode(c.token, zoneId).catch(() => "unknown");
      return { zoneId, zoneName, apex: hostname.toLowerCase() === zoneName.toLowerCase(), sslMode };
    } catch (e) {
      if (e instanceof Error && (e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  /** Read-only: every record at the exact name (all types), normalised for the cutover planner. */
  async listRecordsFor(userId: string, credentialId: string, zoneId: string, hostname: string): Promise<ProviderRec[]> {
    const { token } = await this.creds.resolveToken(userId, credentialId);
    const recs = await this.cf.listDnsRecords(token, zoneId, { name: this.normalizeHostname(hostname) });
    return recs.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl ?? 1, proxied: r.proxied === true }));
  }

  /** Does a CAA policy at `hostname` (or the closest parent up to the zone apex) forbid Let's Encrypt? CAA applies
   *  at the nearest name that has any CAA record. Read-only; a lookup failure reports false (not blocking). */
  async caaBlocksLetsEncrypt(userId: string, credentialId: string, zoneId: string, zoneName: string, hostname: string): Promise<boolean> {
    const { token } = await this.creds.resolveToken(userId, credentialId);
    const labels = hostname.toLowerCase().split(".");
    const zoneLabels = zoneName.toLowerCase().split(".").length;
    for (let i = 0; labels.length - i >= zoneLabels; i++) {
      const name = labels.slice(i).join(".");
      const recs = await this.cf.listDnsRecords(token, zoneId, { name, type: "CAA" }).catch(() => [] as DnsRecord[]);
      if (recs.length > 0) return !caaAllowsLetsEncrypt(recs.map((r) => r.content));
    }
    return false;
  }

  /** The zone's SSL mode ("strict" | "full" | "flexible" | "off"), or "unknown" when the token cannot read it. */
  async zoneSslMode(userId: string, credentialId: string, zoneId: string): Promise<string> {
    const { token } = await this.creds.resolveToken(userId, credentialId);
    return this.cf.getZoneSslMode(token, zoneId).catch(() => "unknown");
  }

  /** PATCH only the TTL of existing records (ledger-first is the caller's job). Proxied records are skipped. */
  async setRecordTtls(userId: string, credentialId: string, zoneId: string, recs: Array<{ id: string; ttl: number }>): Promise<void> {
    const { token } = await this.creds.resolveToken(userId, credentialId);
    for (const r of recs) await this.cf.patchDnsRecord(token, zoneId, r.id, { ttl: r.ttl });
  }

  /**
   * Execute the ledger steps in order. `onStep` is called after EVERY provider write returns (the caller persists
   * the ledger there, so a crash mid-batch leaves `written` accurate). A created record's id is stored on the step.
   * Steps already `written` are skipped (resume).
   */
  async applyLedger(userId: string, credentialId: string, zoneId: string, steps: LedgerRecord[], onStep?: (steps: LedgerRecord[]) => Promise<void>): Promise<LedgerRecord[]> {
    const { token } = await this.creds.resolveToken(userId, credentialId);
    for (const s of steps) {
      if (s.written) continue;
      const a = stepAction(s);
      if (a === "create") {
        const { recordId } = await this.cf.createDnsRecord(token, zoneId, { type: s.type, name: s.name, content: s.new!.content, proxied: s.new!.proxied, ttl: s.new!.ttl });
        s.recordId = recordId;
      } else if (a === "update") {
        await this.cf.patchDnsRecord(token, zoneId, s.recordId!, { content: s.new!.content, ttl: s.new!.ttl, proxied: s.new!.proxied });
      } else if (a === "delete") {
        await this.cf.deleteDnsRecord(token, zoneId, s.recordId!);
      }
      s.written = true;
      s.writtenAt = new Date().toISOString();
      if (onStep) await onStep(steps);
    }
    return steps;
  }

  /**
   * Undo written ledger steps in reverse order. TWO-PHASE: first read every touched record; a record that no
   * longer equals what we wrote (content + proxied; TTL may legitimately have been restored by finalize) is a
   * conflict, and unless `force` NOTHING is written. Then restore: delete what we created, PATCH back what we
   * updated, recreate what we deleted.
   */
  async restoreLedger(userId: string, credentialId: string, zoneId: string, steps: LedgerRecord[], opts: { force: boolean }): Promise<{ restored: number; conflicts: LedgerRecord[] }> {
    const { token } = await this.creds.resolveToken(userId, credentialId);
    const written = steps.filter((s) => s.written && stepAction(s) !== "noop");
    const names = [...new Set(written.map((s) => s.name))];
    const current = new Map<string, DnsRecord>();
    for (const n of names) for (const r of await this.cf.listDnsRecords(token, zoneId, { name: n })) current.set(r.id, r);
    const same = (cur: DnsRecord | undefined, v: { content: string; proxied: boolean } | null) =>
      !!cur && !!v && cur.content === v.content && (cur.proxied === true) === v.proxied;
    const conflicts: LedgerRecord[] = [];
    for (const s of written) {
      const a = stepAction(s);
      if (a === "delete") continue; // a deleted record has nothing to compare; recreate below
      if (a === "create" && !current.has(s.recordId!)) continue; // already gone: fine
      if (!same(current.get(s.recordId!), s.new)) conflicts.push(s);
    }
    if (conflicts.length && !opts.force) return { restored: 0, conflicts };
    let restored = 0;
    for (const s of [...written].reverse()) {
      const a = stepAction(s);
      if (a === "create") {
        if (current.has(s.recordId!)) await this.cf.deleteDnsRecord(token, zoneId, s.recordId!);
        restored++;
      } else if (a === "update") {
        await this.cf.patchDnsRecord(token, zoneId, s.recordId!, { content: s.old!.content, ttl: s.old!.ttl, proxied: s.old!.proxied });
        restored++;
      } else if (a === "delete") {
        const already = [...current.values()].some((r) => r.type === s.type && r.name === s.name && r.content === s.old!.content);
        if (!already) {
          const { recordId } = await this.cf.createDnsRecord(token, zoneId, { type: s.type, name: s.name, content: s.old!.content, proxied: s.old!.proxied, ttl: s.old!.ttl });
          s.recordId = recordId;
        }
        restored++;
      }
    }
    return { restored, conflicts: opts.force ? conflicts : [] };
  }

  /** After a verified flip: put each surviving record's TTL back to what it was (auto stays auto; a record Tugra
   *  created goes to auto). Proxied records and deleted steps are skipped. */
  async restoreTtls(userId: string, credentialId: string, zoneId: string, steps: LedgerRecord[], originalTtl?: number | null): Promise<number> {
    const { token } = await this.creds.resolveToken(userId, credentialId);
    let n = 0;
    for (const s of steps) {
      if (!s.written || !s.new || s.new.proxied || !s.recordId) continue;
      const want = s.old ? (originalTtl ?? s.old.ttl) : 1; // a created record goes to auto; a pre-existing one back to its pre-cutover TTL
      if (want === s.new.ttl) continue;
      await this.cf.patchDnsRecord(token, zoneId, s.recordId, { ttl: want });
      n++;
    }
    return n;
  }

  /** Make the Domain row exist (so the existing verify() works for a flipped host) and record ownership of the
   *  records Tugra CREATED (only those are ever cleaned up). Merges with a row from an earlier auto-setup. */
  async upsertDomainRow(appId: string, hostname: string, credentialId: string, zoneId: string, steps: LedgerRecord[]): Promise<void> {
    const existing = await this.prisma.domain.findUnique({ where: { applicationId_hostname: { applicationId: appId, hostname } }, select: { recordIds: true } });
    const prior: OwnedRecord[] = Array.isArray(existing?.recordIds) ? (existing!.recordIds as unknown as OwnedRecord[]) : [];
    const byId = new Map(prior.map((r) => [r.recordId, r]));
    for (const s of steps) {
      if (!s.written || !s.new || !s.recordId) continue;
      const prev = byId.get(s.recordId);
      byId.set(s.recordId, { type: s.type, name: s.name, recordId: s.recordId, created: (prev?.created ?? false) || s.old === null });
    }
    const common = { dnsCredentialId: credentialId, zoneId, recordIds: [...byId.values()] as unknown as object, mode: "auto", status: "pending", lastError: null };
    await this.prisma.domain.upsert({
      where: { applicationId_hostname: { applicationId: appId, hostname } },
      create: { applicationId: appId, hostname, apex: false, provider: "cloudflare", ...common },
      update: common,
    });
  }

  // ── internals ──

  /** Resolve the full plan: app + decrypted token + zone + the reconciled record set (reads, never writes). The
   *  token is returned SEPARATELY so it never becomes part of the DomainPlan that previewRecords hands back. */
  private async plan(userId: string, appId: string, input: PreviewInput): Promise<{ app: AppRow; token: string; plan: DomainPlan }> {
    const app = await this.resolveApp(userId, appId);
    const hostname = this.normalizeHostname(input.domain);
    const cred = await this.resolveCredential(userId, app, input.credentialId);
    const targetIps = await this.resolveTargetIps(app);
    if (targetIps.v4.length === 0) {
      throw new BadRequestException("the app's server/cluster has no public IPv4 address to point DNS at");
    }
    const { zoneId, zoneName } = await this.cf.findZoneForHostname(cred.token, hostname, cred.cfAccountId);
    const apex = hostname === zoneName;
    const sslMode = await this.cf.getZoneSslMode(cred.token, zoneId).catch(() => "unknown");
    const overwrite = input.overwrite ?? false;

    // Desired records grouped by NAME (one provider list call per name — a name can hold A + AAAA).
    const byName: Array<{ name: string; desired: Array<{ type: string; contents: string[] }> }> = [
      { name: hostname, desired: [{ type: "A", contents: targetIps.v4 }, ...(targetIps.v6.length ? [{ type: "AAAA", contents: targetIps.v6 }] : [])] },
    ];
    // www only makes sense (and only avoids a cert/404) for an apex domain; a subdomain gets just its own A/AAAA.
    if (apex && (input.includeWww ?? true)) byName.push({ name: `www.${hostname}`, desired: [{ type: "CNAME", contents: [hostname] }] });

    const records: PlannedRecord[] = [];
    for (const group of byName) {
      const existingAll = await this.cf.listDnsRecords(cred.token, zoneId, { name: group.name });
      const desiredTypes = new Set(group.desired.map((d) => d.type));
      const cnameDesired = desiredTypes.has("CNAME");
      for (const d of group.desired) {
        const sameType = existingAll.filter((e) => e.type === d.type);
        records.push(...this.reconcileSameType(d.type, group.name, d.contents, sameType, overwrite));
      }
      // Type-incompatible records at this name. A CNAME must stand alone, so ANY other record conflicts with a
      // desired www CNAME. For a desired apex A/AAAA only an existing CNAME conflicts — TXT/MX/NS/CAA coexist and
      // are NEVER touched (we must not delete a user's mail/verification records).
      for (const e of existingAll) {
        if (desiredTypes.has(e.type)) continue; // same-type handled above
        const incompatible = cnameDesired || e.type === "CNAME";
        if (!incompatible) continue;
        records.push({ type: e.type, name: group.name, content: e.content, proxied: e.proxied ?? false, action: overwrite ? "delete" : "conflict", existingId: e.id });
      }
    }
    return { app, token: cred.token, plan: { hostname, apex, zoneId, zoneName, sslMode, credentialId: cred.id, records } };
  }

  /** Diff a desired set of record contents (at one type+name) against the provider's same-type records. A
   *  content-match is kept (noop), or adopted (update to DNS-only) if it was proxied. Shortfall → create. A
   *  foreign record (different content) is a conflict unless overwrite, in which case it is repointed (update)
   *  or deleted (surplus). Correct for multiple records at one name (round-robin A for a multi-node ingress). */
  private reconcileSameType(type: string, name: string, contents: string[], existing: DnsRecord[], overwrite: boolean): PlannedRecord[] {
    const used = new Set<string>();
    const out: PlannedRecord[] = [];
    const unmatched: string[] = [];
    for (const content of contents) {
      const match = existing.find((e) => !used.has(e.id) && e.content === content);
      if (match) {
        used.add(match.id);
        // Adopt a content-identical record that is proxied — the plan guarantees DNS-only, and a stale orange
        // cloud would make verify() resolve Cloudflare edge IPs forever. Flipping proxied on OUR own content is
        // not a clobber, so it is not gated behind overwrite.
        out.push({ type, name, content, proxied: false, action: match.proxied ? "update" : "noop", existingId: match.id });
      } else {
        unmatched.push(content);
      }
    }
    const foreign = existing.filter((e) => !used.has(e.id));
    if (foreign.length && !overwrite) {
      // Don't touch foreign records and don't add ours alongside them (that would split traffic) — surface the
      // conflict; apply refuses until the caller opts into overwrite.
      for (const content of unmatched) out.push({ type, name, content, proxied: false, action: "create", existingId: null });
      for (const f of foreign) out.push({ type, name, content: f.content, proxied: f.proxied ?? false, action: "conflict", existingId: f.id });
    } else {
      let fi = 0;
      for (const content of unmatched) {
        if (overwrite && fi < foreign.length) {
          out.push({ type, name, content, proxied: false, action: "update", existingId: foreign[fi].id });
          fi++;
        } else {
          out.push({ type, name, content, proxied: false, action: "create", existingId: null });
        }
      }
      for (; fi < foreign.length; fi++) {
        out.push({ type, name, content: foreign[fi].content, proxied: foreign[fi].proxied ?? false, action: "delete", existingId: foreign[fi].id });
      }
    }
    return out;
  }

  /** Persist/update the Domain row, MERGING the records we still own with what a previous apply tracked (minus
   *  anything we just deleted) so a re-apply with a different record set never orphans an earlier record. */
  private async persistDomain(
    appId: string,
    plan: DomainPlan,
    input: PreviewInput,
    owned: AppliedRecord[],
    deletedIds: string[],
    status: string,
    lastError: string | null,
  ): Promise<void> {
    const existing = await this.prisma.domain.findUnique({
      where: { applicationId_hostname: { applicationId: appId, hostname: plan.hostname } },
      select: { recordIds: true },
    });
    const prior: OwnedRecord[] = Array.isArray(existing?.recordIds) ? (existing!.recordIds as unknown as OwnedRecord[]) : [];
    const deleted = new Set(deletedIds);
    const keptNow: OwnedRecord[] = owned
      .filter((r) => r.action !== "deleted")
      .map((r) => ({ type: r.type, name: r.name, recordId: r.recordId, created: r.action === "created" }));
    // prior first, current last → a re-owned record keeps its fresh type/name; deleted ids drop out. `created` is
    // OR-ed across runs: a record we created in an earlier apply but merely "kept" (noop) now must STAY ours.
    const byId = new Map<string, OwnedRecord>();
    for (const r of prior) if (!deleted.has(r.recordId)) byId.set(r.recordId, r);
    for (const r of keptNow) {
      const prev = byId.get(r.recordId);
      byId.set(r.recordId, { ...r, created: (prev?.created ?? false) || r.created });
    }
    const recordIds = [...byId.values()];

    const common = { apex: plan.apex, dnsCredentialId: plan.credentialId, zoneId: plan.zoneId, recordIds: recordIds as unknown as object, mode: "auto", status, lastError };
    await this.prisma.domain.upsert({
      where: { applicationId_hostname: { applicationId: appId, hostname: plan.hostname } },
      create: { applicationId: appId, hostname: plan.hostname, provider: "cloudflare", ...common },
      update: common,
    });
  }

  private async resolveApp(userId: string, appId: string, permission: TeamPermission = "apps:deploy"): Promise<AppRow> {
    const app = await this.prisma.application.findUnique({
      where: { id: appId },
      select: { id: true, teamId: true, serverId: true, clusterId: true, domain: true },
    });
    if (!app) throw new NotFoundException("application not found");
    await this.access.requirePermission(userId, app.teamId, permission);
    return app;
  }

  /** The decrypted provider token + its id for the app's team. An explicit credentialId must belong to the app's
   *  team; otherwise the team's single Cloudflare credential is used (ambiguous when it has more than one). */
  private async resolveCredential(userId: string, app: AppRow, credentialId?: string): Promise<{ id: string; token: string; cfAccountId: string | null }> {
    if (credentialId) {
      const c = await this.creds.resolveToken(userId, credentialId);
      if (c.teamId !== app.teamId) throw new ForbiddenException("that DNS credential belongs to another team");
      if (c.provider !== "cloudflare") throw new BadRequestException("only the cloudflare provider is supported");
      return { id: credentialId, token: c.token, cfAccountId: c.cfAccountId };
    }
    const list = await this.creds.cloudflareCredentialsForTeam(app.teamId);
    if (list.length === 0) throw new BadRequestException("no Cloudflare DNS credential for this team — connect one first");
    if (list.length > 1) throw new BadRequestException("multiple Cloudflare credentials for this team — specify credentialId");
    const c = await this.creds.resolveToken(userId, list[0].id);
    return { id: list[0].id, token: c.token, cfAccountId: c.cfAccountId };
  }

  /** The app's reachable public IPs: a cluster app points at its ingress pool (one A per online node, IPv4 for
   *  failover); a single-server app points at the server's observed public IPv4/IPv6. Non-routable addresses
   *  (private/CGNAT/loopback/link-local/multicast/unspecified) are filtered out — never point a public domain at
   *  an address that can't serve it. */
  private async resolveTargetIps(app: AppRow): Promise<{ v4: string[]; v6: string[] }> {
    const routable = (ip: string | null | undefined): ip is string => !!ip && isPublicIp(ip) && !isAlwaysBlockedIp(ip);
    if (app.clusterId) {
      const info = await this.swarmProxy.ingressInfo(app.clusterId);
      const ips = info.nodes.map((n) => n.ip).filter(routable);
      return { v4: unique(ips.filter((ip) => !isIpv6(ip))), v6: unique(ips.filter((ip) => isIpv6(ip))) };
    }
    const server = await this.prisma.server.findUnique({ where: { id: app.serverId }, select: { publicIp: true, publicIpv6: true } });
    const v4 = routable(server?.publicIp) && !isIpv6(server!.publicIp!) ? [server!.publicIp!] : [];
    const v6 = routable(server?.publicIpv6) && isIpv6(server!.publicIpv6!) ? [server!.publicIpv6!] : [];
    return { v4, v6 };
  }

  private normalizeHostname(domain: string): string {
    const host = String(domain ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!HOSTNAME_RE.test(host) || host.includes("*")) {
      throw new BadRequestException("invalid domain — use a bare hostname like app.example.com");
    }
    return host;
  }
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
