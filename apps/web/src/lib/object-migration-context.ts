/**
 * What the page that sends the user to "New object migration" already knows (the server the import puts the service on, the service,
 * a way back). It travels through local storage because the form opens in another tab, expires after a few minutes, is read once, and
 * never holds a key or secret. A back link must be a path on this site.
 */
export interface ObjectMigrationContext {
  targetServerId?: string;
  serviceName?: string;
  backHref?: string;
}

export const OBJECT_MIGRATION_CONTEXT_KEY = "tugra.objmig.context";
const TTL_MS = 15 * 60_000;

const safePath = (v: unknown): string | undefined => (typeof v === "string" && /^\/(?!\/)[^\s\\]{0,200}$/.test(v) ? v : undefined);
const shortStr = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

export function rememberObjectMigrationContext(ctx: ObjectMigrationContext, now = Date.now()): void {
  try {
    window.localStorage.setItem(OBJECT_MIGRATION_CONTEXT_KEY, JSON.stringify({ ...ctx, at: now }));
  } catch {
    /* storage unavailable: the form simply opens blank */
  }
}

/** The context left a moment ago, once. Null when there is none, it is stale, or it is malformed. */
export function takeObjectMigrationContext(now = Date.now()): ObjectMigrationContext | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(OBJECT_MIGRATION_CONTEXT_KEY);
    window.localStorage.removeItem(OBJECT_MIGRATION_CONTEXT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.at !== "number" || now - o.at > TTL_MS || now < o.at) return null;
    const out: ObjectMigrationContext = {};
    const targetServerId = shortStr(o.targetServerId, 80);
    if (targetServerId) out.targetServerId = targetServerId;
    const serviceName = shortStr(o.serviceName, 120);
    if (serviceName) out.serviceName = serviceName;
    const backHref = safePath(o.backHref);
    if (backHref) out.backHref = backHref;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
