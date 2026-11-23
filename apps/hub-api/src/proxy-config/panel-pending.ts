/**
 * The in-flight panel-domain change, shared by the service that drives it (applications/panel-domain.service.ts) and
 * the proxy resolver (ProxyConfigService), so EVERY proxy reconcile that happens while a change is being verified
 * renders the same router file: the new host next to whatever works today. Lives in Redis with a short TTL, so a hub
 * that dies mid-change cannot leave a half-applied router behind for long.
 */
export const PANEL_PENDING_KEY = "instance:panel-domain:pending";
export const PANEL_PENDING_TTL_S = 15 * 60;

export interface PanelPending {
  /** The host being switched TO; null while removing the domain (the IP route is added next to the current host). */
  domain: string | null;
}

export function parsePanelPending(raw: string | null): PanelPending | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { domain?: unknown };
    if (p.domain === null) return { domain: null };
    return typeof p.domain === "string" && p.domain ? { domain: p.domain } : null;
  } catch {
    return null;
  }
}
