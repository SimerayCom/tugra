import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Role } from "@prisma/client";
import { CryptoService } from "../crypto/crypto.service";
import { CoolifyHostGrantService } from "./coolify-host-grant.service";
import { SealedChannelService } from "./sealed-channel.service";

/** Tests only: a tiny in-memory CoolifyHostGrant table that understands the where-clauses the grant service uses. */
type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const val = row[k];
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      if ("gt" in v && !(val > v.gt)) return false;
      if ("lte" in v && !(val <= v.lte)) return false;
      if ("not" in v && !(val !== v.not)) return false;
    } else if (val !== v) return false;
  }
  return true;
}

export function fakeGrantTable() {
  const rows: Row[] = [];
  let n = 0;
  return {
    rows,
    coolifyHostGrant: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const r = { id: `g${++n}`, revokedAt: null, revokedById: null, createdAt: new Date(Date.now() + n), ...data };
        rows.push(r);
        return { ...r };
      }),
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        const r = rows.find((x) => matches(x, where));
        return r ? { ...r } : null;
      }),
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        const r = rows.filter((x) => matches(x, where)).sort((a, b) => b.createdAt - a.createdAt)[0];
        return r ? { ...r } : null;
      }),
      findMany: jest.fn(async ({ where, take }: { where?: Row; take?: number }) => rows.filter((x) => matches(x, where)).slice(0, take ?? 1000).map((r) => ({ ...r }))),
      count: jest.fn(async ({ where }: { where?: Row }) => rows.filter((x) => matches(x, where)).length),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const r = rows.find((x) => matches(x, where));
        if (!r) throw new Error("no row");
        Object.assign(r, data);
        return { ...r };
      }),
    },
  };
}

export interface GrantHarnessOpts {
  roles?: Record<string, Role>;
  online?: boolean;
  features?: string[];
  serverName?: string;
}

export async function grantHarness(o: GrantHarnessOpts = {}) {
  const roles = o.roles ?? { t1: Role.OWNER };
  const table = fakeGrantTable();
  const server = { id: "s1", teamId: "t1", name: o.serverName ?? "coolify-host", capabilities: [] as string[] };
  const prisma = {
    ...table,
    server: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === "s1" ? server : null)),
      findMany: jest.fn(async () => (server.capabilities.includes("coolify_secrets") ? [{ id: "s1" }] : [])),
    },
  } as any;
  const access = {
    requireRole: jest.fn(async (_u: string, teamId: string, allowed: Role[]) => {
      const r = roles[teamId];
      if (!r || !allowed.includes(r)) throw new ForbiddenException("insufficient role for this team");
    }),
  } as any;
  const audit = { log: jest.fn(async () => undefined) } as any;
  const features = new Set(o.features ?? ["coolify_secrets_v1"]);
  const agentWs = { isOnline: jest.fn(() => o.online ?? true), agentSupports: jest.fn((_s: string, f: string) => features.has(f)) } as any;
  const servers = {
    applyCoolifyRunCapability: jest.fn(async (_id: string, cap: string, on: boolean) => {
      const had = server.capabilities.includes(cap);
      if (on && !had) server.capabilities.push(cap);
      if (!on && had) server.capabilities = server.capabilities.filter((c) => c !== cap);
      return had !== on;
    }),
  } as any;
  const crypto = new CryptoService({ get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? "test-passphrase-1234567890" : undefined) } as unknown as ConfigService);
  await crypto.onModuleInit();
  const sealed = new SealedChannelService(crypto);
  const svc = new CoolifyHostGrantService(prisma, access, audit, agentWs, servers, sealed);
  return { svc, table, server, prisma, access, audit, agentWs, servers, sealed, crypto };
}
