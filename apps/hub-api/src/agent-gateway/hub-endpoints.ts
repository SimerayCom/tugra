import { isIPv4 } from "node:net";
import type { HubEndpoint } from "@tugra/shared";

// Pure helpers for the hub endpoint list (hub_endpoints_v1): which addresses an agent may dial, how the list is
// serialised for signing, and how far an address move has got. No DB, no sockets — the stateful part is
// applications/agent-endpoints.service.ts.

/** An address the agent path (/agent) stays routable on after the panel moved: never longer than this. */
export const GRACE_MAX_MS = 7 * 24 * 3600_000;
/** Mirrors the agent's cap (endpoints.MaxEndpoints). */
export const MAX_HUB_ENDPOINTS = 8;

const PIN_RE = /^sha256:[0-9a-f]{64}$/;

/** The agent-facing WebSocket endpoint of a domain (publicly trusted certificate, no pin). */
export function domainEndpoint(domain: string): HubEndpoint {
  return { url: `wss://${domain}/agent` };
}

/** The agent-facing endpoint of a bare IP: TLS with the hub's self-signed certificate, pinned by fingerprint. */
export function ipEndpoint(ip: string, pin: string): HubEndpoint {
  if (!isIPv4(ip)) throw new Error(`not an IPv4 address: ${ip}`);
  if (!PIN_RE.test(pin)) throw new Error("invalid certificate pin");
  return { url: `wss://${ip}/agent`, pin };
}

export function hostOfEndpoint(e: HubEndpoint): string {
  try {
    return new URL(e.url).hostname;
  } catch {
    return "";
  }
}

/** Order-preserving de-dup by URL (first wins), validated and capped. Throws on anything the agent would refuse. */
export function normalizeEndpoints(list: HubEndpoint[]): HubEndpoint[] {
  const out: HubEndpoint[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    const u = new URL(e.url); // throws on garbage
    if (u.protocol !== "wss:") throw new Error(`hub endpoint must be wss://: ${e.url}`);
    if (u.username || u.password) throw new Error("hub endpoint must not carry credentials");
    if (isIPv4(u.hostname) && !e.pin) throw new Error(`a bare-IP endpoint needs a certificate pin: ${e.url}`);
    if (e.pin !== undefined && !PIN_RE.test(e.pin)) throw new Error("invalid certificate pin");
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push(e.pin ? { url: e.url, pin: e.pin } : { url: e.url });
  }
  if (out.length === 0) throw new Error("empty endpoint list");
  return out.slice(0, MAX_HUB_ENDPOINTS);
}

/** The exact bytes that get signed and sent: a stable JSON array of {url, pin?}. */
export function serializeEndpoints(list: HubEndpoint[]): string {
  return JSON.stringify(normalizeEndpoints(list));
}

/** Strictly increasing revision (anti-replay on the agent): wall-clock milliseconds, never repeating within a process,
 *  and raised past anything an agent says it already holds (`observe`) — so a clock that jumped forward once, or a hub
 *  restored on a host whose clock is behind, cannot leave agents refusing every later list as "older". */
export class RevClock {
  private last = 0;
  next(now: number = Date.now()): number {
    this.last = Math.max(this.last + 1, now);
    return this.last;
  }
  /** The highest revision handed out or learned so far. */
  peek(): number {
    return this.last;
  }
  /** An agent reported holding `rev`; true when that is above everything this process knew (the next rev is then above it). */
  observe(rev: number): boolean {
    if (!Number.isSafeInteger(rev) || rev <= this.last || rev > MAX_OBSERVED_REV) return false;
    this.last = rev;
    return true;
  }
}

/** An agent-reported revision above this is ignored (a compromised agent must not push the counter out of range). */
const MAX_OBSERVED_REV = 2 ** 52;

// ---- grace ------------------------------------------------------------------------------------------------------

/**
 * Persisted while agents are being moved to a new hub address: the address they are moving TO (`primary`) and the
 * addresses kept routable for `/agent` (`fallbacks`: the old domain and/or the IP route) so an agent that has not moved
 * yet — offline during the change, or too old to understand the message — is never stranded.
 */
export interface AgentEndpointGrace {
  v: 1;
  startedAt: number;
  expiresAt: number;
  primary: HubEndpoint;
  fallbacks: HubEndpoint[];
  /** The owner pressed "stop waiting": the grace ends at the next sweep even if agents have not moved. */
  confirmedAt?: number;
  /** The panel itself has not been switched to the new address yet (the panel-domain job is still running): agents may
   *  already be on the new endpoint, but the grace must not end — the hub's own address is still the old one. */
  pendingSwitch?: boolean;
  /** The still-running grace of an EARLIER change this one replaced (only on a pendingSwitch grace): if this change
   *  fails before the switch, it is restored instead of dropped — its stragglers must not lose their routes. */
  previous?: AgentEndpointGrace;
}

export function newGrace(primary: HubEndpoint, fallbacks: HubEndpoint[], now: number, maxMs: number = GRACE_MAX_MS): AgentEndpointGrace {
  const kept = fallbacks.filter((f) => f.url !== primary.url);
  return { v: 1, startedAt: now, expiresAt: now + Math.min(maxMs, GRACE_MAX_MS), primary, fallbacks: kept };
}

/** Defensive read of the JSON column: anything malformed is "no grace" (never throws). */
export function parseGrace(raw: unknown, nested = false): AgentEndpointGrace | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Partial<AgentEndpointGrace>;
  if (g.v !== 1 || typeof g.startedAt !== "number" || typeof g.expiresAt !== "number") return null;
  try {
    const primary = normalizeEndpoints([g.primary as HubEndpoint])[0]!;
    const fallbacks = Array.isArray(g.fallbacks) && g.fallbacks.length ? normalizeEndpoints(g.fallbacks) : [];
    return {
      v: 1,
      startedAt: g.startedAt,
      expiresAt: g.expiresAt,
      primary,
      fallbacks,
      ...(typeof g.confirmedAt === "number" ? { confirmedAt: g.confirmedAt } : {}),
      ...(g.pendingSwitch === true ? { pendingSwitch: true } : {}),
      ...(!nested && g.previous ? ((p) => (p ? { previous: p } : {}))(parseGrace(g.previous, true)) : {}),
    };
  } catch {
    return null;
  }
}

export function graceActive(g: AgentEndpointGrace | null, now: number): g is AgentEndpointGrace {
  return !!g && now < g.expiresAt && g.confirmedAt === undefined;
}

/** What the proxy must keep routing for `/agent` during a grace: old domain names, and whether the IP route too. */
export function graceRoutes(g: AgentEndpointGrace | null, now: number): { hosts: string[]; ip: boolean } {
  if (!graceActive(g, now)) return { hosts: [], ip: false };
  const hosts: string[] = [];
  let ip = false;
  for (const e of [...g.fallbacks, g.primary]) {
    const h = hostOfEndpoint(e);
    if (!h) continue;
    if (isIPv4(h)) ip = true;
    else if (e !== g.primary && !hosts.includes(h)) hosts.push(h); // the primary's own routes are the panel's normal ones
  }
  return { hosts, ip };
}

// ---- progress -----------------------------------------------------------------------------------------------------

export type AgentMoveReason = "moved" | "waiting" | "offline" | "old_agent";

export interface AgentMoveRow {
  id: string;
  name: string;
  /** moved: reports the new endpoint · waiting: online, has not switched yet (or refused the list) · offline · old_agent:
   *  online but cannot follow (no hub_endpoints_v1) */
  reason: AgentMoveReason;
  error?: string | null;
}

export interface AgentMoveInput {
  id: string;
  name: string;
  online: boolean;
  /** Live capability: the connected agent advertised hub_endpoints_v1 (false when offline / older). */
  supported: boolean;
  /** The endpoint URL the agent last reported its session is on. */
  active: string | null;
  error: string | null;
}

/** Per-server verdict against the address agents are moving to. `moved` ⇔ the last reported active endpoint IS that address. */
export function summarizeMove(primaryUrl: string, servers: AgentMoveInput[]): { total: number; moved: number; pending: AgentMoveRow[] } {
  const pending: AgentMoveRow[] = [];
  let moved = 0;
  for (const s of servers) {
    if (s.active === primaryUrl) {
      moved++;
      continue;
    }
    const reason: AgentMoveReason = !s.online ? "offline" : !s.supported ? "old_agent" : "waiting";
    pending.push({ id: s.id, name: s.name, reason, ...(s.error ? { error: s.error } : {}) });
  }
  return { total: servers.length, moved, pending };
}
