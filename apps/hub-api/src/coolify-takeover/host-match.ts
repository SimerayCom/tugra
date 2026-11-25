import { isIP } from "node:net";
import { HOST_EVIDENCE_KINDS, HOST_EVIDENCE_STRENGTH, type HostEvidence, type HostEvidenceKind, type HostIdentityFacts, type HostMatchCandidate, type HostMatchVerdict } from "@tugra/shared";
import { comparableAddress, isPrivateAddress } from "../importer/server-match";

/**
 * Which Tugra server is the same machine as a Coolify server (Coolify hub takeover, lane D). PURE: no I/O, deterministic for any
 * ordering of its inputs. The evidence ladder:
 *
 *  - E1 identity: the same sshd host-key fingerprint confirms ALONE. A machine id or Docker engine id is copied by VM clones and
 *    snapshot restores, so one of them alone is NOT enough: it confirms only together with the other one (both present and equal),
 *    with the host key, or with a unique address (E2). A lone machine id or engine id match is `probable`.
 *    Two values that both exist and differ are a CONFLICT: the address is then a stale reuse, not the machine.
 *  - E2 address (probable): the same address. A public address names one machine; a private one (RFC 1918, ULA, link-local) only
 *    counts when exactly one Tugra server AND one Coolify server carry it (the range is shared across providers); a CGNAT /
 *    Tailscale address (100.64/10) only counts together with an equal host name (E3). A match through an address that several
 *    Coolify servers share (one NAT address, different SSH ports) is never probable.
 *  - E3 weak (never decides): an equal host name.
 *
 * `certain` needs an E1 match, always, and one that is not a lone machine id or engine id. `probable` is exactly one candidate with
 * no conflict that has a unique address or a lone machine id / engine id match. Everything else with a
 * candidate is `ambiguous` (the owner picks); no candidate is `none`. The Coolify row of the host the agent runs on is "this
 * server" and is never matched to another one by address or name. No source address is copied into a verdict: only kinds.
 */

/** A Coolify server as the matcher sees it. `ips` and `hostname` come from the Coolify `ip` column (an address or a host name). */
export interface CoolifyHostInput {
  uuid: string;
  /** The Coolify `ip` field, an address or a host name (resolved by the caller when it must be, e.g. split-horizon). */
  address: string | null | undefined;
  /** Extra addresses the Coolify side knows for this machine (public IPv4 and IPv6 of the local row). */
  extraAddresses?: readonly (string | null | undefined)[];
  /** The Coolify host itself (id 0): "this server", the one the reading agent runs on. */
  isLocal?: boolean;
  /** Identity facts known for this Coolify server (a probe result, lane C). Absent = unknown, never "different". */
  facts?: HostIdentityFacts;
}

/** A Tugra server as the matcher sees it. */
export interface TugraHostInput {
  serverId: string;
  name: string;
  teamId: string;
  publicIp: string | null;
  publicIpv6: string | null;
  hostname: string | null;
  reportedIps: readonly string[];
  facts?: HostIdentityFacts;
  /** The caller holds `servers:manage` in this server's team: only such a server can be proposed or linked. */
  canManage: boolean;
}

export interface MatchOptions {
  /** The Tugra server whose agent reads this Coolify: the Coolify `isLocal` row is that machine. */
  localServerId?: string;
}

type IdentityKey = "sshHostKeyFp" | "machineIdHash" | "dockerEngineId";
const IDENTITY: ReadonlyArray<readonly [HostEvidenceKind, IdentityKey]> = [
  ["ssh_host_key", "sshHostKeyFp"],
  ["machine_id", "machineIdHash"],
  ["docker_engine_id", "dockerEngineId"],
];

const norm = (v: string | null | undefined): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** The values one fact set holds for an identity kind. A key fingerprint is base64: case matters, so it is only trimmed. */
function identityValues(f: HostIdentityFacts, k: IdentityKey): string[] {
  if (k === "sshHostKeyFp") return [...new Set([f.sshHostKeyFp, ...(f.sshHostKeyFps ?? [])].map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean))];
  const v = norm(f[k]);
  return v ? [v] : [];
}

/**
 * E1 evidence between two fact sets: a kind both sides report is `equal` or a conflict; a kind one side lacks says nothing. A machine has
 * several sshd host keys: the fingerprint one side SAW is the other's when it is any one of the keys the other reports.
 */
export function identityEvidence(a: HostIdentityFacts | undefined, b: HostIdentityFacts | undefined): HostEvidence[] {
  const out: HostEvidence[] = [];
  if (!a || !b) return out;
  for (const [kind, k] of IDENTITY) {
    const x = identityValues(a, k);
    const y = identityValues(b, k);
    if (x.length && y.length) out.push({ kind, equal: x.some((v) => y.includes(v)) });
  }
  return out;
}

/** 100.64.0.0/10 (carrier-grade NAT, Tailscale): shared by many machines and by many networks. */
function isCgnat(a: string): boolean {
  if (isIP(a) !== 4) return false;
  const [p, q] = a.split(".").map(Number);
  return p === 100 && q >= 64 && q <= 127;
}

type AddressClass = "public" | "private" | "cgnat" | "name" | "none";
function classify(a: string | null): AddressClass {
  if (!a) return "none";
  if (isIP(a) === 0) return "name";
  if (isCgnat(a)) return "cgnat";
  return isPrivateAddress(a) ? "private" : "public";
}

/** The comparable addresses a Tugra server reports (public IPs and every reported interface IP), canonical, no host names. */
function tugraAddresses(s: TugraHostInput): string[] {
  const out = new Set<string>();
  for (const x of [s.publicIp, s.publicIpv6, ...s.reportedIps]) {
    const c = comparableAddress(x);
    if (c && isIP(c) !== 0) out.add(c);
  }
  return [...out];
}

const rank = (k: HostEvidenceKind): number => HOST_EVIDENCE_KINDS.indexOf(k);
const sortEvidence = (e: HostEvidence[]): HostEvidence[] => [...e].sort((x, y) => rank(x.kind) - rank(y.kind) || Number(y.equal) - Number(x.equal));

export function matchHosts(coolify: readonly CoolifyHostInput[], tugra: readonly TugraHostInput[], opts: MatchOptions = {}): HostMatchVerdict[] {
  const hosts = [...coolify].sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  const servers = [...tugra].sort((a, b) => (a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0));
  const byId = new Map(servers.map((s) => [s.serverId, s]));
  const reports = new Map<string, Set<string>>(); // address -> Tugra servers (any permission) that report it
  for (const s of servers) {
    for (const a of tugraAddresses(s)) reports.set(a, (reports.get(a) ?? new Set()).add(s.serverId));
  }
  // How many Coolify servers carry each address (one NAT address with several SSH ports is shared).
  const coolifyAt = new Map<string, number>();
  const coolifyAddresses = (h: CoolifyHostInput): string[] => {
    const set = new Set<string>();
    for (const x of [h.address, ...(h.extraAddresses ?? [])]) {
      const c = comparableAddress(x);
      if (c) set.add(c);
    }
    return [...set];
  };
  for (const h of hosts) if (!h.isLocal) for (const a of coolifyAddresses(h)) coolifyAt.set(a, (coolifyAt.get(a) ?? 0) + 1);

  return hosts.map((h) => verdictFor(h));

  function verdictFor(h: CoolifyHostInput): HostMatchVerdict {
    const none = (): HostMatchVerdict => ({ coolifyServerUuid: h.uuid, status: "none", tugraServerId: null, candidates: [] });

    // The Coolify host itself is the machine the reading agent runs on: never matched by address or name.
    if (h.isLocal) {
      const local = opts.localServerId ? byId.get(opts.localServerId) : undefined;
      if (!local || !local.canManage) return none();
      // The agent session that read this Coolify runs on this machine by construction: that session is what makes the verdict certain.
      // Evidence is only a REAL comparison (facts probed on the Coolify host against the agent server's), never the agent's own facts
      // against themselves; a conflict between the two says the session is not on this host after all.
      const all = identityEvidence(h.facts, local.facts);
      if (all.some((e) => !e.equal)) return none();
      const evidence = sortEvidence(all);
      return { coolifyServerUuid: h.uuid, status: "certain", tugraServerId: local.serverId, candidates: [{ serverId: local.serverId, name: local.name, teamId: local.teamId, evidence }] };
    }

    const addrs = coolifyAddresses(h);
    const hostName = addrs.find((a) => classify(a) === "name") ?? null;
    const candidates: Array<{ s: TugraHostInput; evidence: HostEvidence[]; conflict: boolean; identity: boolean; loneIdentity: boolean; strongAddress: boolean }> = [];
    for (const s of servers) {
      if (!s.canManage) continue; // never proposed, never linked
      const evidence: HostEvidence[] = identityEvidence(h.facts, s.facts);
      const conflict = evidence.some((e) => !e.equal);
      const nameEqual = !!hostName && !!s.hostname && norm(s.hostname).replace(/\.$/, "") === hostName;
      const mine = new Set(tugraAddresses(s));
      let addressSeen = false;
      let strongAddress = false;
      for (const a of addrs) {
        const cls = classify(a);
        if (cls === "name" || !mine.has(a)) continue;
        addressSeen = true;
        // One machine carries it: exactly one Tugra server reports it and exactly one Coolify row has it (a NAT address with
        // several SSH ports, or the same private range on two networks, never decides). CGNAT also needs the equal host name.
        const unique = (reports.get(a)?.size ?? 0) === 1 && (coolifyAt.get(a) ?? 0) === 1;
        if (unique && (cls === "public" || cls === "private" || (cls === "cgnat" && nameEqual))) strongAddress = true;
      }
      // E1 that confirms: the host key alone; a machine id or engine id only with another E1 fact or a unique address (clones copy them).
      const equalIdentity = evidence.filter((e) => e.equal).map((e) => e.kind);
      const hostKey = equalIdentity.includes("ssh_host_key");
      const identity = !conflict && (hostKey || equalIdentity.length >= 2 || (equalIdentity.length === 1 && strongAddress));
      const loneIdentity = !conflict && !identity && equalIdentity.length === 1;
      if (addressSeen) evidence.push({ kind: "ip", equal: true });
      if (nameEqual) evidence.push({ kind: "hostname", equal: true });
      if (!evidence.some((e) => e.equal)) continue; // no shared fact: not a candidate (a bare conflict says nothing useful)
      candidates.push({ s, evidence: sortEvidence(evidence), conflict, identity, loneIdentity, strongAddress });
    }

    const view = (c: (typeof candidates)[number]): HostMatchCandidate => ({ serverId: c.s.serverId, name: c.s.name, teamId: c.s.teamId, evidence: c.evidence });
    const shown = candidates.map(view);

    const certain = candidates.filter((c) => c.identity);
    if (certain.length === 1) return { coolifyServerUuid: h.uuid, status: "certain", tugraServerId: certain[0].s.serverId, candidates: shown };
    if (certain.length > 1) return { coolifyServerUuid: h.uuid, status: "ambiguous", tugraServerId: null, candidates: shown };

    // An identity CONFLICT vetoes the address: the same address on a different machine is a stale reuse.
    const open = candidates.filter((c) => !c.conflict);
    const probable = open.filter((c) => c.strongAddress || c.loneIdentity);
    if (probable.length === 1) return { coolifyServerUuid: h.uuid, status: "probable", tugraServerId: probable[0].s.serverId, candidates: shown };
    if (open.length > 0) return { coolifyServerUuid: h.uuid, status: "ambiguous", tugraServerId: null, candidates: shown };
    return { coolifyServerUuid: h.uuid, status: "none", tugraServerId: null, candidates: shown };
  }
}

/** True when a verdict rests on identity: the property `certain` must always satisfy. */
export function verdictHasIdentity(v: HostMatchVerdict): boolean {
  const c = v.candidates.find((x) => x.serverId === v.tugraServerId);
  return !!c?.evidence.some((e) => e.equal && HOST_EVIDENCE_STRENGTH[e.kind] === "identity");
}
