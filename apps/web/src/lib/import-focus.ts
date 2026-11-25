import type { ImportPlan } from "./types";
import { type ScopeSelection, emptySelection, sourceHostRows, sourceProjectRows } from "./import-scope";

/**
 * What a page that sends the user to the import knows already: which source (Coolify or Dokploy), where it lives, and optionally a
 * source server or project to start from. It travels through same-tab storage, never the URL, so a crafted link cannot aim the
 * import at someone else's host. It never holds a token.
 */
export interface ImportFocus {
  kind?: "coolify" | "dokploy";
  /** The source panel's address (http or https). */
  address?: string | null;
  /** The Tugra server the user came from (shown as a note; the scope step does the matching). */
  fromServerName?: string;
  /** A source server (its uuid in the source) to start with, and the Tugra server it is already connected as. */
  sourceServerUuid?: string;
  targetServerId?: string;
  targetTeamId?: string;
  /** A source project (its uuid) to start with. */
  sourceProjectUuid?: string;
}

export const IMPORT_FOCUS_KEY = "tugra.import.focus";
/** The last source address a connection was made to, per source kind. An address only, never a token. */
export const lastImportUrlKey = (kind: "coolify" | "dokploy"): string => `tugra.import.lastUrl.${kind}`;

const URL_RE = /^https?:\/\/\S+$/i;
const short = (v: unknown, max = 120): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** Keep only well-formed fields of a stored focus (storage is same-origin, but treat it as input all the same). */
export function parseImportFocus(raw: string | null): ImportFocus | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out: ImportFocus = {};
  if (o.kind === "coolify" || o.kind === "dokploy") out.kind = o.kind;
  if (typeof o.address === "string" && URL_RE.test(o.address) && o.address.length <= 300) out.address = o.address;
  const fromServerName = short(o.fromServerName);
  if (fromServerName) out.fromServerName = fromServerName;
  const sourceServerUuid = short(o.sourceServerUuid, 80);
  if (sourceServerUuid) out.sourceServerUuid = sourceServerUuid;
  const targetServerId = short(o.targetServerId, 80);
  if (targetServerId) out.targetServerId = targetServerId;
  const targetTeamId = short(o.targetTeamId, 80);
  if (targetTeamId) out.targetTeamId = targetTeamId;
  const sourceProjectUuid = short(o.sourceProjectUuid, 80);
  if (sourceProjectUuid) out.sourceProjectUuid = sourceProjectUuid;
  return Object.keys(out).length > 0 ? out : null;
}

/** Leave a focus for the import page (same tab). Best effort: without storage the import simply opens blank. */
export function rememberImportFocus(focus: ImportFocus): void {
  try {
    window.sessionStorage.setItem(IMPORT_FOCUS_KEY, JSON.stringify(focus));
  } catch {
    /* storage unavailable */
  }
}

/** Read the focus once and clear it. */
export function takeImportFocus(): ImportFocus | null {
  try {
    const raw = window.sessionStorage.getItem(IMPORT_FOCUS_KEY);
    window.sessionStorage.removeItem(IMPORT_FOCUS_KEY);
    return parseImportFocus(raw);
  } catch {
    return null;
  }
}

export function rememberLastImportUrl(kind: "coolify" | "dokploy", address: string): void {
  try {
    if (URL_RE.test(address)) window.localStorage.setItem(lastImportUrlKey(kind), address);
  } catch {
    /* storage unavailable */
  }
}

export function lastImportUrl(kind: "coolify" | "dokploy"): string | null {
  try {
    const v = window.localStorage.getItem(lastImportUrlKey(kind));
    return v && URL_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The scope step's starting pick for a focus: the one source server or project the user came from, ticked, and (for a server) already
 * placed on the Tugra server it is connected as. Null when the focus names nothing this plan contains, so the step opens as usual.
 * Never places anything on a server it was not told about.
 */
export function focusSelection(plan: ImportPlan, focus: ImportFocus | null): ScopeSelection | null {
  if (!focus) return null;
  if (focus.sourceServerUuid) {
    const row = sourceHostRows(plan).find((r) => r.ref === focus.sourceServerUuid);
    if (row) {
      return {
        ...emptySelection(),
        mode: "servers",
        hosts: new Set([row.ref]),
        placement: focus.targetServerId ? { [row.ref]: focus.targetServerId } : {},
        ...(focus.targetTeamId ? { teamId: focus.targetTeamId } : {}),
      };
    }
  }
  if (focus.sourceProjectUuid) {
    const row = sourceProjectRows(plan).find((r) => r.ref === focus.sourceProjectUuid);
    if (row) {
      const hosts = sourceHostRows(plan);
      return { ...emptySelection(), mode: "projects", projects: new Set([row.ref]), placement: focus.targetServerId && hosts.length === 1 ? { [hosts[0].ref]: focus.targetServerId } : {}, ...(focus.targetTeamId ? { teamId: focus.targetTeamId } : {}) };
    }
  }
  return null;
}
