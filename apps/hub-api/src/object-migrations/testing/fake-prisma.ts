/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A tiny in-memory stand-in for the two Prisma delegates the object-migration module uses (just the where/include/order
 * shapes the code issues, nothing more), so the state-machine tests run against real row semantics instead of mock
 * call-counting.
 */
export type Row = Record<string, any>;

const eq = (a: any, b: any): boolean => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Row | undefined, store: Store): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === "migration") {
      const mig = store.migs.get(row.migrationId);
      if (!mig || !matches(mig, cond as Row, store)) return false;
      continue;
    }
    if (k === "buckets") {
      const some = (cond as any).some;
      const list = [...store.buckets.values()].filter((b) => b.migrationId === row.id);
      if (!list.some((b) => matches(b, some, store))) return false;
      continue;
    }
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !(cond as any).in.includes(v)) return false;
      if ("not" in cond && eq(v, (cond as any).not)) return false;
    } else if (!eq(v, cond)) return false;
  }
  return true;
}

export class Store {
  migs = new Map<string, Row>();
  buckets = new Map<string, Row>();
  private seq = 0;
  nextId(p: string): string {
    return `${p}${String(++this.seq).padStart(20, "0")}`.slice(0, 25);
  }
}

const sortBy = (rows: Row[], orderBy: any, store: Store): Row[] => {
  const keys: any[] = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0] as [string, any];
      let av = a[k];
      let bv = b[k];
      if (k === "migration") {
        const f = Object.keys(dir)[0];
        av = store.migs.get(a.migrationId)?.[f];
        bv = store.migs.get(b.migrationId)?.[f];
        const d = Object.values(dir)[0];
        const c = av < bv ? -1 : av > bv ? 1 : 0;
        if (c) return d === "desc" ? -c : c;
        continue;
      }
      const c = av < bv ? -1 : av > bv ? 1 : 0;
      if (c) return dir === "desc" ? -c : c;
    }
    return 0;
  });
};

export function makeFakePrisma(store = new Store()) {
  const withBuckets = (m: Row, include?: any): Row => (include?.buckets ? { ...m, buckets: sortBy([...store.buckets.values()].filter((b) => b.migrationId === m.id), include.buckets.orderBy ?? { idx: "asc" }, store).map((b) => ({ ...b })) } : { ...m });
  const bucketDefaults = (): Row => ({ exclude: [], selected: false, status: "PENDING", srcObjects: null, srcBytes: null, dstObjects: null, dstBytes: null, doneObjects: null, doneBytes: null, diffMissing: null, diffDiffer: null, diffExtra: null, versioning: null, config: null, configStatus: null, lastError: null, startedAt: null, finishedAt: null });
  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
  };
  const prisma: any = {
    objectMigration: {
      create: async ({ data, include }: any) => {
        const m = { id: store.nextId("ckmig"), status: "DRAFT", phase: null, preserve: true, removeExtraneous: false, mergeIntoExisting: false, cancelRequested: false, warnings: null, createdAt: new Date(Date.now() + store.migs.size), updatedAt: new Date(), finishedAt: null, ...data };
        store.migs.set(m.id, m);
        return withBuckets(m, include);
      },
      findUnique: async ({ where, include, select }: any) => {
        const m = store.migs.get(where.id);
        if (!m) return null;
        if (select) return Object.fromEntries(Object.keys(select).map((k) => [k, m[k]]));
        return withBuckets(m, include);
      },
      findMany: async ({ where, include, orderBy, take, select }: any = {}) => {
        let rows = sortBy([...store.migs.values()].filter((m) => matches(m, where, store)), orderBy, store);
        if (take) rows = rows.slice(0, take);
        return rows.map((m) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, m[k]])) : withBuckets(m, include)));
      },
      update: async ({ where, data }: any) => {
        const m = store.migs.get(where.id);
        if (!m) throw new Error("not found");
        apply(m, data);
        m.updatedAt = new Date();
        return { ...m };
      },
      delete: async ({ where }: any) => {
        store.migs.delete(where.id);
        for (const [id, b] of store.buckets) if (b.migrationId === where.id) store.buckets.delete(id);
        return {};
      },
    },
    objectMigrationBucket: {
      create: async ({ data }: any) => {
        const b = { id: store.nextId("ckbkt"), ...bucketDefaults(), ...data };
        if ([...store.buckets.values()].some((x) => x.migrationId === b.migrationId && (x.srcBucket === b.srcBucket || x.idx === b.idx))) throw new Error("unique violation");
        store.buckets.set(b.id, b);
        return { ...b };
      },
      update: async ({ where, data }: any) => {
        const b = store.buckets.get(where.id);
        if (!b) throw new Error("not found");
        apply(b, data);
        return { ...b };
      },
      updateMany: async ({ where, data }: any) => {
        let n = 0;
        for (const b of store.buckets.values()) if (matches(b, where, store)) (apply(b, data), n++);
        return { count: n };
      },
      findFirst: async ({ where }: any) => {
        const b = [...store.buckets.values()].find((x) => matches(x, where, store));
        return b ? { ...b } : null;
      },
      findMany: async ({ where, orderBy, take, include }: any = {}) => {
        let rows = sortBy([...store.buckets.values()].filter((b) => matches(b, where, store)), orderBy, store);
        if (take) rows = rows.slice(0, take);
        return rows.map((b) => (include?.migration ? { ...b, migration: { ...store.migs.get(b.migrationId) } } : { ...b }));
      },
      count: async ({ where }: any) => [...store.buckets.values()].filter((b) => matches(b, where, store)).length,
      delete: async ({ where }: any) => {
        store.buckets.delete(where.id);
        return {};
      },
    },
    server: { findUnique: jest.fn() },
  };
  return { prisma, store };
}
