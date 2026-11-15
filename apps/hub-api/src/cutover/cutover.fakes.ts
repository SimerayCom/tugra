import { Prisma } from "@prisma/client";

/** Test-only in-memory fakes for the cutover service: a tiny Prisma (the tables it touches) and a Cloudflare zone. */

type Row = Record<string, unknown>;

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    const cur = row[k];
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      const o = v as { in?: unknown[]; not?: unknown; lt?: Date; equals?: unknown };
      if (o.in) return o.in.includes(cur);
      if ("not" in o) return o.not === null ? cur !== null && cur !== undefined : cur !== o.not;
      if (o.lt) return cur instanceof Date && cur.getTime() < o.lt.getTime();
      return true;
    }
    return cur === v || (v === null && cur === undefined);
  });
}

function table(defaults: (data: Row) => Row, uniq?: (r: Row) => string) {
  const rows: Row[] = [];
  let n = 0;
  return {
    rows,
    findMany: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown } = {}) => {
      const out = rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
      if (orderBy) out.sort((a, b) => String(a.hostname ?? "").localeCompare(String(b.hostname ?? "")));
      return out;
    },
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const r = [...rows].reverse().find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const flat: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(where)) {
        if (v && typeof v === "object" && !(v instanceof Date)) Object.assign(flat, v);
        else flat[k] = v;
      }
      const r = rows.find((x) => matches(x, flat));
      return r ? { ...r } : null;
    },
    create: async ({ data }: { data: Row }) => {
      const row = defaults({ id: `id${++n}`, ...data });
      if (uniq) {
        const key = uniq(row);
        if (rows.some((r) => uniq(r) === key)) throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
      }
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const r = rows.find((x) => x.id === where.id);
      if (!r) throw new Error("not found");
      Object.assign(r, normalize(data), { updatedAt: new Date() });
      return { ...r };
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, normalize(data), { updatedAt: new Date() });
      return { count: hit.length };
    },
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => rows.filter((r) => matches(r, where)).length,
  };
}

function normalize(data: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === Prisma.JsonNull ? null : v;
  return out;
}

export function fakeCutoverPrisma() {
  const now = () => new Date();
  const cutoverDomain = table(
    (d) => ({
      role: "primary", state: "PLANNED", blockReason: null, dnsMode: "manual", dnsCredentialId: null, zoneId: null, sslMode: null, challenge: "http01", targetIps: null, ledger: null,
      viaWildcard: false, proxied: null, dnsObserved: "unknown", originalTtl: null, targetTtl: null, ttlLoweredAt: null, earliestFlipAt: null, certState: "unknown", certIssuer: null,
      certNotAfter: null, certError: null, precheck: null, precheckAt: null, needsDeploy: false, stateful: false, warnings: [], flippedAt: null, verifiedAt: null, finalizedAt: null,
      revertedAt: null, lastError: null, createdAt: now(), updatedAt: now(), ...d,
    }),
    (r) => `${r.opId}|${r.applicationId}|${r.hostname}`,
  );
  const cutoverRun = table(
    (d) => ({ activeKey: null, status: "running", batchesDone: 0, heartbeatAt: now(), lastError: null, startedAt: now(), finishedAt: null, ...d }),
    (r) => (r.activeKey ? String(r.activeKey) : `free${Math.random()}`),
  );
  const apps = new Map<string, Row>();
  const servers = new Map<string, Row>();
  const prisma = {
    cutoverDomain: {
      ...cutoverDomain,
      // the service looks a row up by its compound unique key
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const c = where.opId_applicationId_hostname as { opId: string; applicationId: string; hostname: string } | undefined;
        if (c) {
          const r = cutoverDomain.rows.find((x) => x.opId === c.opId && x.applicationId === c.applicationId && x.hostname === c.hostname);
          return r ? { ...r } : null;
        }
        return cutoverDomain.findUnique({ where });
      },
    },
    cutoverRun,
    cutoverCert: { count: async () => 0 },
    bulkOperation: { findUnique: async () => ({ cancelRequestedAt: prisma.__cancel ? new Date() : null }) },
    application: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((i) => apps.get(i)).filter(Boolean) },
    appServiceDomain: { findMany: async () => [] as Row[] },
    server: { findUnique: async ({ where }: { where: { id: string } }) => servers.get(where.id) ?? null },
    domain: { findUnique: async () => null, upsert: async () => ({}) },
    __cancel: false,
    __apps: apps,
    __servers: servers,
  };
  return prisma;
}

export interface ZoneRec { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean }

/** An in-memory Cloudflare zone behind the CloudflareApiClient surface the cutover touches. */
export function fakeCloudflare(initial: ZoneRec[] = []) {
  const zone = { records: initial.map((r) => ({ ...r })), calls: [] as string[], sslMode: "strict", failCreateOn: null as string | null, failPatchAfter: Infinity, patches: 0 };
  let n = 0;
  const cf = {
    findZoneForHostname: jest.fn(async (_t: string, host: string) => {
      if (!host.endsWith("example.com")) throw Object.assign(new Error("no zone"), { status: 404 });
      return { zoneId: "z1", zoneName: "example.com" };
    }),
    getZoneSslMode: jest.fn(async () => zone.sslMode),
    listDnsRecords: jest.fn(async (_t: string, _z: string, f?: { name?: string; type?: string }) => {
      zone.calls.push("list");
      return zone.records.filter((r) => (!f?.name || r.name === f.name) && (!f?.type || r.type === f.type)).map((r) => ({ ...r }));
    }),
    createDnsRecord: jest.fn(async (_t: string, _z: string, rec: Omit<ZoneRec, "id">) => {
      zone.calls.push(`create:${rec.content}`);
      if (zone.failCreateOn === rec.content) throw new Error("cf 500");
      const id = `n${++n}`;
      zone.records.push({ ...rec, id });
      return { recordId: id };
    }),
    patchDnsRecord: jest.fn(async (_t: string, _z: string, id: string, p: Partial<ZoneRec>) => {
      zone.patches++;
      if (zone.patches > zone.failPatchAfter) throw new Error("cf 500");
      zone.calls.push(`patch:${id}:${JSON.stringify(p)}`);
      const r = zone.records.find((x) => x.id === id);
      if (!r) throw new Error("gone");
      Object.assign(r, p);
      return { ...r };
    }),
    deleteDnsRecord: jest.fn(async (_t: string, _z: string, id: string) => {
      zone.calls.push(`delete:${id}`);
      zone.records = zone.records.filter((r) => r.id !== id);
    }),
  };
  return { zone, cf };
}
