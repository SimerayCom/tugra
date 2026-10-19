import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { CloudflareApiClient, type DnsRecord } from "../tunnel/cloudflare-api.client";
import { DnsCredentialsService } from "./dns-credentials.service";
import { buildMailDnsRecords, type MailDnsInput, type MailDnsRecord } from "./mail-dns";

/** A planned mail DNS record and what applying it will do. Each mail record owns a distinct "slot" in the zone
 *  (keyed by name + type + a purpose signature), so reconciliation NEVER touches unrelated records at the same
 *  name (a domain-verification TXT, another service's record):
 *   - "noop":     the exact record already exists → leave it.
 *   - "create":   the slot is empty → POST a new record.
 *   - "update":   repoint an existing slot record to our content (only with overwrite, or an MX priority fix).
 *   - "delete":   remove a surplus foreign record in the slot (only with overwrite — collapsing a split MX /
 *                 duplicate SPF into a single correct record).
 *   - "conflict": the slot holds a DIFFERENT record (a foreign MX/SPF/DMARC/DKIM, or a CNAME where a TXT must go)
 *                 → apply refuses unless overwrite. */
export interface PlannedMailRecord {
  type: "MX" | "TXT";
  name: string;
  content: string;
  priority?: number; // MX only
  purpose: "mx" | "spf" | "dmarc" | "dkim";
  action: "create" | "update" | "noop" | "delete" | "conflict";
  existingId: string | null;
  existingContent?: string; // what the slot currently holds (advisory, for a conflict/update/delete)
}

export interface MailDnsPlan {
  domain: string;
  mailHost: string;
  zoneId: string;
  zoneName: string;
  records: PlannedMailRecord[];
}

export interface AppliedMailRecord {
  type: string;
  name: string;
  purpose: string;
  recordId: string;
  action: "created" | "updated" | "kept" | "deleted";
}

export interface MailDnsApplyResult {
  domain: string;
  mailHost: string;
  records: AppliedMailRecord[];
}

/** The caller's request: the mail record shape (domain/mailHost/dkim/dmarc) + which DNS credential to use. */
export interface MailDnsRequest extends MailDnsInput {
  credentialId: string;
  overwrite?: boolean;
}

/**
 * One-click MAIL DNS auto-setup (v1: Cloudflare). Given a mail domain + the host that handles its mail, it
 * publishes the records a self-hosted mail setup needs to actually DELIVER — MX + SPF + a monitor-first DMARC
 * (+ DKIM when the mail server's public key is supplied). It is CONSERVATIVE with an existing zone: an existing
 * MX, SPF, DMARC or DKIM record that differs from ours is a "conflict" that apply refuses to touch unless
 * `overwrite` is set — so one click never silently takes over a domain that is already receiving mail — and it
 * ignores unrelated TXT records at the apex (verification tokens etc.) entirely.
 *
 * Authorization rides on the DNS credential: resolveToken enforces the `integrations` team permission on the
 * credential's own team, and the decrypted token is kept in-process (never returned in a plan/result/audit).
 */
@Injectable()
export class MailDnsService {
  constructor(
    private readonly audit: AuditService,
    private readonly cf: CloudflareApiClient,
    private readonly creds: DnsCredentialsService,
  ) {}

  async previewMailRecords(userId: string, req: MailDnsRequest): Promise<MailDnsPlan> {
    const { plan } = await this.plan(userId, req);
    return plan;
  }

  async applyMailRecords(userId: string, req: MailDnsRequest): Promise<MailDnsApplyResult> {
    const { token, plan } = await this.plan(userId, req);
    const overwrite = req.overwrite ?? false;
    const conflicts = plan.records.filter((r) => r.action === "conflict");
    if (conflicts.length) {
      throw new ConflictException(
        `these existing mail DNS records would be overwritten — re-run with overwrite to replace them: ${conflicts
          .map((c) => `${c.type} ${c.name} (${c.purpose})`)
          .join(", ")}`,
      );
    }
    const applied: AppliedMailRecord[] = [];
    try {
      for (const r of plan.records) {
        if (r.action === "noop") {
          applied.push({ type: r.type, name: r.name, purpose: r.purpose, recordId: r.existingId!, action: "kept" });
        } else if (r.action === "update") {
          const { recordId } = await this.cf.upsertDnsRecord(token, plan.zoneId, {
            type: r.type, name: r.name, content: r.content, proxied: false, priority: r.priority, existingRecordId: r.existingId,
          });
          applied.push({ type: r.type, name: r.name, purpose: r.purpose, recordId, action: "updated" });
        } else if (r.action === "create") {
          const { recordId } = await this.cf.createDnsRecord(token, plan.zoneId, {
            type: r.type, name: r.name, content: r.content, proxied: false, priority: r.priority,
          });
          applied.push({ type: r.type, name: r.name, purpose: r.purpose, recordId, action: "created" });
        } else if (r.action === "delete") {
          await this.cf.deleteDnsRecord(token, plan.zoneId, r.existingId!);
          applied.push({ type: r.type, name: r.name, purpose: r.purpose, recordId: r.existingId!, action: "deleted" });
        }
      }
    } catch (e) {
      // A partial failure must still be recorded: audit what we DID write (ids only, never the token/values)
      // before rethrowing so the mutation is never invisible. A re-run is idempotent (noop/create heal the zone).
      const error = e instanceof Error ? e.message : "mail dns apply failed";
      await this.audit
        .log({
          actor: userId,
          action: "dns.mail.apply",
          target: plan.domain,
          meta: {
            domain: plan.domain, mailHost: plan.mailHost, zoneId: plan.zoneId, overwrite, partial: true, error,
            applied: applied.map((a) => ({ purpose: a.purpose, recordId: a.recordId, action: a.action })),
          },
        })
        .catch(() => undefined);
      throw e;
    }
    const counts = {
      created: applied.filter((r) => r.action === "created").length,
      updated: applied.filter((r) => r.action === "updated").length,
      deleted: applied.filter((r) => r.action === "deleted").length,
      kept: applied.filter((r) => r.action === "kept").length,
    };
    // Non-fatal: the records are already written, so a flaky audit sink must not turn a successful apply into a 500.
    await this.audit
      .log({ actor: userId, action: "dns.mail.apply", target: plan.domain, meta: { domain: plan.domain, mailHost: plan.mailHost, zoneId: plan.zoneId, overwrite, ...counts } })
      .catch(() => undefined);
    return { domain: plan.domain, mailHost: plan.mailHost, records: applied };
  }

  // ── internals ──

  /** Resolve the token + zone, build the desired records, and reconcile each against its slot (reads, never
   *  writes). The token is returned SEPARATELY so it never becomes part of the MailDnsPlan a preview hands back. */
  private async plan(userId: string, req: MailDnsRequest): Promise<{ token: string; plan: MailDnsPlan }> {
    const cred = await this.creds.resolveToken(userId, req.credentialId); // enforces `integrations` on the cred's team
    if (cred.provider !== "cloudflare") throw new BadRequestException("only the cloudflare provider is supported");

    let desired: MailDnsRecord[];
    try {
      // The builder does the real semantic validation (FQDN, DKIM selector, DMARC-tag injection guards); surface
      // its failures as 400, not a 500, since the inputs come straight from an API body.
      desired = buildMailDnsRecords({
        domain: req.domain,
        mailHost: req.mailHost,
        dkim: req.dkim,
        dmarcPolicy: req.dmarcPolicy,
        dmarcReportTo: req.dmarcReportTo,
      });
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : "invalid mail DNS input");
    }
    const domain = desired[0].name; // MX is always first and lives at the (normalized) mail domain
    const mailHost = desired[0].content.replace(/\.$/, "");

    const { zoneId, zoneName } = await this.cf.findZoneForHostname(cred.token, domain, cred.cfAccountId);
    const overwrite = req.overwrite ?? false;
    const records: PlannedMailRecord[] = [];
    for (const d of desired) records.push(...(await this.reconcile(cred.token, zoneId, d, overwrite)));
    return { token: cred.token, plan: { domain, mailHost, zoneId, zoneName, records } };
  }

  /** Reconcile ONE desired mail record against the zone. Returns one or more planned records: the record's own
   *  action plus, under overwrite, any surplus foreign records in the slot (collapsed via delete). MX is
   *  multi-valued (coexisting backup MX hosts are left alone); SPF/DMARC/DKIM are single-valued (a second record
   *  is invalid, so a coexisting foreign one is a conflict, or deleted under overwrite). */
  private async reconcile(token: string, zoneId: string, d: MailDnsRecord, overwrite: boolean): Promise<PlannedMailRecord[]> {
    const base = { type: d.type, name: d.name, content: d.content, priority: d.priority, purpose: d.purpose };

    // A CNAME occupying a TXT record's name (common for delegated DKIM/DMARC) blocks creating the TXT and is a
    // different record type we must never silently convert — surface it as a conflict the operator resolves by hand.
    if (d.type === "TXT") {
      const cnames = await this.cf.listDnsRecords(token, zoneId, { name: d.name, type: "CNAME" });
      if (cnames.length) return [{ ...base, action: "conflict", existingId: cnames[0].id, existingContent: cnames[0].content }];
    }

    const existing = await this.cf.listDnsRecords(token, zoneId, { name: d.name, type: d.type });
    const slot = existing.filter((e) => inSlot(d, e));
    const exact = slot.find((e) => contentEq(d, e));
    const foreign = slot.filter((e) => e !== exact);
    const shown = (e: DnsRecord) => (d.type === "TXT" ? txtVal(e.content) : e.content);
    const delOf = (e: DnsRecord): PlannedMailRecord => ({ type: d.type, name: d.name, content: shown(e), priority: e.priority, purpose: d.purpose, action: "delete", existingId: e.id, existingContent: shown(e) });
    const conflictOf = (e: DnsRecord): PlannedMailRecord => ({ ...base, action: "conflict", existingId: e.id, existingContent: shown(e) });

    if (exact) {
      // Our record is already present. Only an MX whose priority differs is repointed, and only under overwrite —
      // otherwise we leave the operator's chosen priority alone (a deliberate backup ordering).
      const priorityFix = d.type === "MX" && typeof d.priority === "number" && typeof exact.priority === "number" && exact.priority !== d.priority && overwrite;
      const head: PlannedMailRecord = priorityFix
        ? { ...base, action: "update", existingId: exact.id, existingContent: exact.content }
        : { ...base, action: "noop", existingId: exact.id };
      if (d.type === "MX") return [head]; // MX is multi-valued — sibling backup MX hosts are valid, leave them
      if (!foreign.length) return [head];
      // A second SPF/DMARC/DKIM alongside ours is invalid: drop it (overwrite) or surface it (conflict).
      return overwrite ? [head, ...foreign.map(delOf)] : [head, ...foreign.map(conflictOf)];
    }

    if (!foreign.length) return [{ ...base, action: "create", existingId: null }];
    if (!overwrite) return foreign.map(conflictOf); // never silently insert ourselves beside a domain's live mail
    // Full takeover: repoint the first foreign record to ours and delete the rest (collapse a split MX / dup SPF).
    return [{ ...base, action: "update", existingId: foreign[0].id, existingContent: shown(foreign[0]) }, ...foreign.slice(1).map(delOf)];
  }
}

/** Does this existing record occupy the SAME slot as the desired mail record? The name+type already match (the
 *  list call filtered on them); this narrows TXT to the one semantic record we own, so a domain-verification or
 *  unrelated TXT at the apex is invisible to reconciliation. TXT content is normalized first (Cloudflare wraps
 *  TXT values in quotes and chunks long ones). */
function inSlot(d: MailDnsRecord, e: DnsRecord): boolean {
  if (e.type !== d.type) return false;
  switch (d.purpose) {
    case "mx":
      return true; // any MX at the mail domain is the delivery slot
    case "spf":
      return txtVal(e.content).toLowerCase().startsWith("v=spf1"); // the single SPF TXT — ignore other apex TXT
    case "dmarc":
      return txtVal(e.content).toLowerCase().startsWith("v=dmarc1"); // the DMARC policy TXT at _dmarc.<domain>
    case "dkim":
      return true; // <selector>._domainkey.<domain> is a name dedicated to this DKIM key
    default:
      return false;
  }
}

/** Is the existing record's content identical to what we want? MX content is a host (CF usually stores it with
 *  no trailing dot while we add one) so compare hosts case-insensitively; a TXT value is normalized (unquoted,
 *  de-chunked) then compared verbatim (a DKIM key is case-sensitive base64). */
function contentEq(d: MailDnsRecord, e: DnsRecord): boolean {
  if (d.type === "MX") {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");
    return norm(e.content) === norm(d.content);
  }
  return txtVal(e.content) === d.content.trim();
}

/** Normalize a TXT record's content as Cloudflare returns it: a quoted value, or a long value split into several
 *  adjacent quoted chunks (`"part1" "part2"`), becomes the plain concatenated string. An already-unquoted value
 *  (or any non-Cloudflare shape) is returned trimmed, unchanged. This is what makes SPF/DMARC detection and
 *  DKIM-key idempotency correct — without it an existing quoted SPF is invisible (→ a duplicate SPF, a PermError
 *  that breaks mail) and a chunked DKIM key never matches (→ a perpetual conflict). */
function txtVal(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith('"')) return s;
  const chunks = s.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!chunks) return s;
  return chunks.map((c) => c.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}
