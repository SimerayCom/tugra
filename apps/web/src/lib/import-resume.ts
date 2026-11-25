import { restoreSelection, serializeSelection, type ScopeSelection } from "./import-scope";

// What the import wizard keeps in sessionStorage so a refresh resumes at the first step instead of the blank connect form.
// Only names and ids: the source kind, the address (a URL with no credentials), the hub session id, the picked scope and the
// per-database copy modes. The API token is NEVER stored; the hub session (1 hour) is what lets the wizard re-read the plan.

export const IMPORT_RESUME_KEY = "tugra.import.resume";

export interface ImportResume {
  kind: "coolify" | "dokploy";
  baseUrl: string;
  sessionId: string;
  selection?: ScopeSelection;
  dbModes: Record<string, "volume">;
}

/** An address that is safe to keep: http(s), no credentials in it. */
const keepableUrl = (u: string): boolean => /^https?:\/\/[^@\s]{1,500}$/i.test(u);
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function saveImportResume(r: ImportResume, store: Pick<Storage, "setItem"> = window.sessionStorage): void {
  try {
    if (!SESSION_ID_RE.test(r.sessionId)) return;
    store.setItem(
      IMPORT_RESUME_KEY,
      JSON.stringify({ v: 1, kind: r.kind, baseUrl: keepableUrl(r.baseUrl) ? r.baseUrl : "", sessionId: r.sessionId, selection: r.selection ? serializeSelection(r.selection) : undefined, dbModes: r.dbModes }),
    );
  } catch {
    /* storage unavailable or full: the wizard just does not resume */
  }
}

export function loadImportResume(store: Pick<Storage, "getItem"> = window.sessionStorage): ImportResume | null {
  try {
    const raw = store.getItem(IMPORT_RESUME_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.v !== 1 || (o.kind !== "coolify" && o.kind !== "dokploy") || typeof o.sessionId !== "string" || !SESSION_ID_RE.test(o.sessionId)) return null;
    const modes: Record<string, "volume"> = {};
    if (o.dbModes && typeof o.dbModes === "object" && !Array.isArray(o.dbModes)) {
      for (const [k, v] of Object.entries(o.dbModes as Record<string, unknown>)) if (v === "volume" && k !== "__proto__") modes[k] = "volume";
    }
    const baseUrl = typeof o.baseUrl === "string" && keepableUrl(o.baseUrl) ? o.baseUrl : "";
    const selection = typeof o.selection === "string" ? restoreSelection(o.selection) : undefined;
    return { kind: o.kind, baseUrl, sessionId: o.sessionId, ...(selection ? { selection } : {}), dbModes: modes };
  } catch {
    return null;
  }
}

export function clearImportResume(store: Pick<Storage, "removeItem"> = window.sessionStorage): void {
  try {
    store.removeItem(IMPORT_RESUME_KEY);
  } catch {
    /* ignore */
  }
}
