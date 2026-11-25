/**
 * Coolify hub takeover, lane D (match a Coolify server to a Tugra server): the shared vocabulary. Types and constants only.
 * Evidence is stored and shown as kinds and short fingerprints; a source server's address is never copied into a plan.
 * Lane D owns this file. Other lanes only import from it.
 */

/** E1 identity proves it alone; E2 address makes it probable; E3 is weak and never decides by itself. */
export const HOST_EVIDENCE_KINDS = ["ssh_host_key", "machine_id", "docker_engine_id", "ip", "hostname", "cloud_instance_id"] as const;
export type HostEvidenceKind = (typeof HOST_EVIDENCE_KINDS)[number];
export type HostEvidenceStrength = "identity" | "address" | "weak";
export const HOST_EVIDENCE_STRENGTH: Readonly<Record<HostEvidenceKind, HostEvidenceStrength>> = {
  ssh_host_key: "identity",
  machine_id: "identity",
  docker_engine_id: "identity",
  ip: "address",
  hostname: "weak",
  cloud_instance_id: "weak",
};

export interface HostEvidence {
  kind: HostEvidenceKind;
  /** True when both sides report it and the two values are equal. False is a conflict (it can veto an address match). */
  equal: boolean;
}

/** certain = an identity match; probable = one address match with no conflict; ambiguous = several candidates or a conflict; none = nothing. */
export type HostMatchStatus = "certain" | "probable" | "ambiguous" | "none";
export type HostLinkedBy = "auto" | "user";

export interface HostMatchCandidate {
  serverId: string;
  name: string;
  teamId: string;
  evidence: HostEvidence[];
}

/** The verdict for one Coolify server. `localhost` rows are "this server" and never appear as a candidate of another. */
export interface HostMatchVerdict {
  coolifyServerUuid: string;
  status: HostMatchStatus;
  /** Set only for certain and probable. */
  tugraServerId: string | null;
  candidates: HostMatchCandidate[];
}

/** The identity facts a Tugra agent reports in addition to its addresses (hashes and ids only; no content). */
export interface HostIdentityFacts {
  /** SHA-256 fingerprint of the sshd host key. */
  sshHostKeyFp?: string;
  /** sha256("tugra-mid-v1" + /etc/machine-id), hex. The raw id is never reported. */
  machineIdHash?: string;
  dockerEngineId?: string;
}

/** An entry of `CoolifyInventory.serverLinks` (a JSON column). `linkedBy` and `evidence` are additive: a row written before them reads as `linkedBy: "user"`. */
export interface CoolifyServerLink {
  teamId: string;
  serverId: string;
  linkedBy?: HostLinkedBy;
  evidence?: HostEvidence[];
}
