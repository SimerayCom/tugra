/** A tiny in-memory stand-in for the Prisma tables the volume stream writes, with just the where/data operators it uses. */
import { Prisma } from "@prisma/client";

type Row = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v) && typeof v !== "bigint";
const eq = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if ((a === undefined || a === null) && (b === undefined || b === null)) return true;
  if (typeof a === "bigint" || typeof b === "bigint") return Number(a) === Number(b);
  return a === b;
};
const num = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as Array<Record<string, unknown>>).some((w) => matches(row, w))) return false;
    } else if (k === "AND") {
      if (!(v as Array<Record<string, unknown>>).every((w) => matches(row, w))) return false;
    } else if (k === "NOT") {
      if (matches(row, v as Record<string, unknown>)) return false;
    } else if (isObj(v)) {
      const cur = row[k];
      if ("in" in v && !(v.in as unknown[]).some((x) => eq(x, cur))) return false;
      if ("lt" in v && !(cur != null && num(cur) < num(v.lt))) return false;
      if ("gte" in v && !(cur != null && num(cur) >= num(v.gte))) return false;
      if ("not" in v && eq(cur, v.not)) return false;
      if ("startsWith" in v && !(typeof cur === "string" && cur.startsWith(String(v.startsWith)))) return false;
    } else if (!eq(row[k], v)) return false;
  }
  return true;
}

function apply(row: Row, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === Prisma.DbNull) row[k] = null;
    else if (isObj(v) && "increment" in v) row[k] = (typeof row[k] === "bigint" ? Number(row[k]) : (row[k] as number)) + Number(v.increment);
    else row[k] = v;
  }
}

export class MemTable {
  rows: Row[] = [];
  private seq = 0;
  constructor(private readonly prefix: string, private readonly defaults: () => Row = () => ({}), private readonly unique: string[][] = []) {}

  private clone(r: Row | undefined): Row | null {
    return r ? { ...r } : null;
  }
  private normalize(where: Record<string, unknown>): Record<string, unknown> {
    // compound unique selectors: { opId_itemRef: { opId, itemRef } } / { transferId_idx: {...} }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(where)) {
      if (k.includes("_") && isObj(v) && !("in" in v) && !("lt" in v)) Object.assign(out, v);
      else out[k] = v;
    }
    return out;
  }
  findUnique = jest.fn(async (a: { where: Record<string, unknown> }) => this.clone(this.rows.find((r) => matches(r, this.normalize(a.where)))));
  findFirst = jest.fn(async (a: { where?: Record<string, unknown> } = {}) => this.clone(this.rows.find((r) => matches(r, a.where))));
  findMany = jest.fn(async (a: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc"> } = {}) => {
    let out = this.rows.filter((r) => matches(r, a.where)).map((r) => ({ ...r }));
    const ob = a.orderBy ? Object.entries(a.orderBy)[0] : undefined;
    if (ob) out = out.sort((x, y) => (num(x[ob[0]]) - num(y[ob[0]])) * (ob[1] === "desc" ? -1 : 1));
    return out;
  });
  count = jest.fn(async (a: { where?: Record<string, unknown> } = {}) => this.rows.filter((r) => matches(r, a.where)).length);
  create = jest.fn(async (a: { data: Row }) => {
    const row: Row = { id: `${this.prefix}${String(++this.seq).padStart(24 - this.prefix.length, "0")}`, createdAt: new Date(), ...this.defaults(), ...a.data };
    for (const u of this.unique) if (this.rows.some((r) => u.every((k) => eq(r[k], row[k])))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    this.rows.push(row);
    return { ...row };
  });
  updateMany = jest.fn(async (a: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
    const hit = this.rows.filter((r) => matches(r, a.where));
    for (const r of hit) apply(r, a.data);
    return { count: hit.length };
  });
  update = jest.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const r = this.rows.find((x) => matches(x, this.normalize(a.where)));
    if (!r) throw new Error("not found");
    apply(r, a.data);
    return { ...r };
  });
  deleteMany = jest.fn(async (a: { where?: Record<string, unknown> } = {}) => {
    const keep = this.rows.filter((r) => !matches(r, a.where));
    const n = this.rows.length - keep.length;
    this.rows = keep;
    return { count: n };
  });
}

export function memTransfers(): MemTable {
  return new MemTable(
    "cktr",
    () => ({ state: "PENDING", attempt: 1, partsDone: 0, bytesDone: 0, rawBytesDone: 0, rawBytesTotal: null, rawBytesFinal: null, entries: null, fingerprint: null, runId: null, lastBeatAt: null, phase: null, bps: null, error: null, startedAt: null, finishedAt: null, updatedAt: new Date() }),
    [["opId", "itemRef"]],
  );
}
export const memParts = (): MemTable => new MemTable("ckpart", () => ({}), [["transferId", "idx"]]);
export const memTasks = (): MemTable => new MemTable("cktask", () => ({ status: "PENDING", output: null, steps: null, result: null }), [["opId", "itemRef"]]);

/** `$transaction` that supports both the interactive form (callback gets the same tables) and the array form. */
export function memTransaction(tables: Record<string, unknown>) {
  return async (arg: unknown): Promise<unknown> => {
    if (typeof arg === "function") return (arg as (tx: unknown) => Promise<unknown>)(tables);
    return Promise.all(arg as Array<Promise<unknown>>);
  };
}
