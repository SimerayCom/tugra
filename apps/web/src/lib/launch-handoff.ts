import type { ImportRemoteKind, ImportApplyExtras } from "./types";
import { restoreSelection, serializeSelection, type ImportScope, type PlacementKind } from "./import-scope";

// What the import preview hands to the guided-run launch page. The launch is its own page (not a modal), so the choices made on the
// preview (what is moving, where each source server goes, the acknowledgements and service choices) travel in sessionStorage and
// survive a reload of the page. Only ids, refs and names: no token, no secret value. The plan itself is read again on the page.

export const LAUNCH_HANDOFF_KEY = "tugra.import.launch";
export const LAUNCH_PAGE_PATH = "/import/guided/new";

export interface LaunchHandoff {
  kind: ImportRemoteKind;
  sessionId: string;
  /** The plan hash the owner reviewed: the page refuses to start on a plan that has since changed. */
  planHash: string;
  extras: ImportApplyExtras;
  scope: ImportScope | null;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HASH_RE = /^[A-Za-z0-9]{8,128}$/;
const MAX_REFS = 5000;

/** The launch page of an import session. The id in the address lets a reload find its handoff and nothing else. */
export const launchPageHref = (sessionId: string): string => `${LAUNCH_PAGE_PATH}?s=${encodeURIComponent(sessionId)}`;

const isStrRecord = (v: unknown): v is Record<string, string> => !!v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, x]) => k !== "__proto__" && typeof x === "string" && k.length <= 200 && x.length <= 200);

export function saveLaunchHandoff(h: LaunchHandoff, store: Pick<Storage, "setItem"> = window.sessionStorage): boolean {
  try {
    if (!SESSION_ID_RE.test(h.sessionId)) return false;
    const s = h.scope;
    store.setItem(
      LAUNCH_HANDOFF_KEY,
      JSON.stringify({
        v: 1,
        kind: h.kind,
        sessionId: h.sessionId,
        planHash: h.planHash,
        extras: h.extras,
        scope: s
          ? {
              selection: serializeSelection(s.selection),
              inScope: [...s.inScope].sort(),
              narrowed: s.narrowed,
              defaultServerId: s.defaultServerId,
              serverMap: s.serverMap,
              placed: s.placed,
              placementKind: s.placementKind,
              ...(s.multiTeam ? { multiTeam: true } : {}),
            }
          : null,
      }),
    );
    return true;
  } catch {
    return false; // storage unavailable or full: the page then says there is nothing to start and links back
  }
}

export function loadLaunchHandoff(store: Pick<Storage, "getItem"> = window.sessionStorage): LaunchHandoff | null {
  try {
    const raw = store.getItem(LAUNCH_HANDOFF_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.v !== 1 || (o.kind !== "coolify" && o.kind !== "dokploy" && o.kind !== "caprover")) return null;
    if (typeof o.sessionId !== "string" || !SESSION_ID_RE.test(o.sessionId) || typeof o.planHash !== "string" || !HASH_RE.test(o.planHash)) return null;
    const extras = o.extras && typeof o.extras === "object" && !Array.isArray(o.extras) ? (o.extras as ImportApplyExtras) : {};
    let scope: ImportScope | null = null;
    if (o.scope !== null && o.scope !== undefined) {
      const s = o.scope as Record<string, unknown>;
      const selection = typeof s.selection === "string" ? restoreSelection(s.selection) : undefined;
      if (!selection || !Array.isArray(s.inScope) || s.inScope.length > MAX_REFS || !s.inScope.every((x) => typeof x === "string")) return null;
      if (!isStrRecord(s.placed) || !isStrRecord(s.placementKind) || typeof s.defaultServerId !== "string" || (s.serverMap !== undefined && s.serverMap !== null && !isStrRecord(s.serverMap))) return null;
      scope = {
        selection,
        inScope: new Set(s.inScope as string[]),
        narrowed: s.narrowed === true,
        defaultServerId: s.defaultServerId,
        serverMap: s.serverMap ? (s.serverMap as Record<string, string>) : undefined,
        placed: s.placed,
        placementKind: s.placementKind as Record<string, PlacementKind>,
        ...(s.multiTeam === true ? { multiTeam: true } : {}),
      };
    }
    return { kind: o.kind, sessionId: o.sessionId, planHash: o.planHash, extras, scope };
  } catch {
    return null;
  }
}

export function clearLaunchHandoff(store: Pick<Storage, "removeItem"> = window.sessionStorage): void {
  try {
    store.removeItem(LAUNCH_HANDOFF_KEY);
  } catch {
    /* ignore */
  }
}
