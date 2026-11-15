import type { DnsAutomationService } from "../dns/dns-automation.service";

/** The slice of PrismaService the repoint reads. */
export interface MoveDnsDb {
  domain: {
    findMany(args: { where: { applicationId: string } }): Promise<
      { id: string; hostname: string; mode: string; dnsCredentialId: string | null; recordIds: unknown }[]
    >;
  };
}

export interface RepointResult {
  repointed: string[];
  /** Hostnames that could not be repointed safely or at all (the operator finishes them by hand). */
  failed: string[];
  /** Domains Tugra does not manage records for: nothing to do automatically. */
  manual: string[];
}

interface OwnedRecord {
  type?: unknown;
  name?: unknown;
  recordId?: unknown;
}

function ownedRecords(recordIds: unknown): { type: string; name: string; recordId: string }[] {
  if (!Array.isArray(recordIds)) return [];
  return (recordIds as OwnedRecord[]).filter(
    (r): r is { type: string; name: string; recordId: string } => !!r && typeof r.type === "string" && typeof r.name === "string" && typeof r.recordId === "string",
  );
}

/**
 * After the app is healthy on the target, repoint the DNS records Tugra itself wrote for the app's custom domains.
 *
 * CONSERVATIVE by construction: for each auto-managed Domain row that carries recorded A/AAAA ids, the plan is previewed
 * first (no overwrite). Only when every record that would be replaced is one of the RECORDED ids does it apply with
 * `overwrite: true`; a foreign record at that name (the user's own) is never touched — that domain is reported as manual.
 * `resolveTargetIps` (inside the DNS service) reads the app's NEW serverId, so the records point at the target. Any
 * failure is reported, never thrown: a DNS hiccup is a warning, not a reason to roll back a working move.
 */
export async function repointMoveDomains(
  deps: { db: MoveDnsDb; dns: Pick<DnsAutomationService, "previewRecords" | "applyRecords"> },
  appId: string,
  actorUserId: string,
): Promise<RepointResult> {
  const out: RepointResult = { repointed: [], failed: [], manual: [] };
  const rows = await deps.db.domain.findMany({ where: { applicationId: appId } });
  for (const d of rows) {
    const owned = ownedRecords(d.recordIds);
    const hasAddress = owned.some((r) => r.type === "A" || r.type === "AAAA");
    if (d.mode !== "auto" || !hasAddress) {
      out.manual.push(d.hostname);
      continue;
    }
    const input = { domain: d.hostname, credentialId: d.dnsCredentialId ?? undefined, includeWww: owned.some((r) => r.name.startsWith("www.")) };
    try {
      const plan = await deps.dns.previewRecords(actorUserId, appId, input);
      const conflicts = plan.records.filter((r) => r.action === "conflict");
      const ownedIds = new Set(owned.map((r) => r.recordId));
      if (conflicts.some((c) => !c.existingId || !ownedIds.has(c.existingId))) {
        out.failed.push(d.hostname); // would clobber a record we did not write
        continue;
      }
      await deps.dns.applyRecords(actorUserId, appId, { ...input, overwrite: conflicts.length > 0 });
      out.repointed.push(d.hostname);
    } catch {
      out.failed.push(d.hostname);
    }
  }
  return out;
}
