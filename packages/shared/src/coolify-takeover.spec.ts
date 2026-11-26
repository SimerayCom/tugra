import {
  AGENT_CAPABILITIES,
  AGENT_FEATURE_COOLIFY_CLEANUP,
  AGENT_FEATURE_COOLIFY_SECRETS,
  AGENT_FEATURE_COOLIFY_SSH,
  AGENT_FEATURE_COOLIFY_TAKEOVER,
  AGENT_SESSION_URL_PREFIX,
  CAMPAIGN_STATUSES,
  CLEANUP_STATUSES,
  COMPLETENESS_KINDS,
  COOLIFY_RUN_CAPABILITIES,
  COOLIFY_SECRET_CLASSES,
  COOLIFY_SECRET_REF_KINDS,
  COOLIFY_SECRET_TIER,
  COOLIFY_SECRET_WIRE_CODES,
  COOLIFY_SECRETS_GRANT_DEFAULT_HOURS,
  COOLIFY_SECRETS_GRANT_MAX_HOURS,
  COOLIFY_SSH_GRANT_DEFAULT_HOURS,
  COOLIFY_SSH_GRANT_MAX_HOURS,
  COOLIFY_SSH_LIMITS,
  COOLIFY_SSH_OPS,
  COOLIFY_SSH_RESULT_CODES,
  COOLIFY_SSH_TARGET_STATES,
  COOLIFY_SSH_TERMINAL_STATES,
  HOST_EVIDENCE_KINDS,
  HOST_EVIDENCE_STRENGTH,
  IMPORT_TRANSPORTS,
  PLACEMENT_KINDS,
  PLACEMENT_LOCK_REASONS,
  PROJECT_MOVE_PHASES,
  REMNANT_KINDS,
  TAKEOVER_CERT_STATES,
  TAKEOVER_FAILURE_CODES,
  TAKEOVER_ISSUES,
  TAKEOVER_STATUSES,
  agentSessionBaseUrl,
  isAgentSessionBaseUrl,
  type AgentMessage,
  type CoolifySecretRecord,
  type CoolifySecretsReqMsg,
  type HubMessage,
} from "./index";

const unique = (list: readonly string[]): boolean => new Set(list).size === list.length;

describe("coolify takeover contract: capabilities", () => {
  it("adds the four opt-in capabilities after migrate, once each, never in a default grant", () => {
    const added = ["coolify_secrets", "coolify_ssh", "coolify_takeover", "coolify_cleanup"];
    for (const c of added) expect(AGENT_CAPABILITIES.filter((x) => x === c)).toHaveLength(1);
    expect(AGENT_CAPABILITIES.slice(AGENT_CAPABILITIES.indexOf("migrate") + 1)).toEqual(added);
    expect(unique(AGENT_CAPABILITIES)).toBe(true);
  });

  it("lists the run-granted set exactly as the four added capabilities, all inside AGENT_CAPABILITIES", () => {
    expect([...COOLIFY_RUN_CAPABILITIES]).toEqual(["coolify_secrets", "coolify_ssh", "coolify_takeover", "coolify_cleanup"]);
    for (const c of COOLIFY_RUN_CAPABILITIES) expect(AGENT_CAPABILITIES).toContain(c);
    // migrate and the file capabilities are NOT run-only in this sense
    expect(COOLIFY_RUN_CAPABILITIES as readonly string[]).not.toContain("migrate");
  });

  it("names a feature flag per frame family, each ending in _v1 and unique", () => {
    const flags = [AGENT_FEATURE_COOLIFY_SECRETS, AGENT_FEATURE_COOLIFY_SSH, AGENT_FEATURE_COOLIFY_TAKEOVER, AGENT_FEATURE_COOLIFY_CLEANUP];
    expect(flags).toEqual(["coolify_secrets_v1", "coolify_ssh_v1", "coolify_takeover_v1", "coolify_cleanup_v1"]);
  });

  it("types the signed frames into the hub and agent message unions", () => {
    const req: CoolifySecretsReqMsg = { type: "coolify_secrets_req", reqId: "r", runId: "run", classes: ["env"], refs: ["env:abc"], recipientKey: "k", exp: 1, capability: "coolify_secrets" };
    const hub: HubMessage = req;
    const agent: AgentMessage = { type: "coolify_ssh_result", reqId: "r", ok: false, code: "unreachable" };
    expect(hub.type).toBe("coolify_secrets_req");
    expect(agent.type).toBe("coolify_ssh_result");
  });
});

describe("coolify takeover contract: secrets", () => {
  it("gives every consent class a tier; T0 material is not a class", () => {
    expect(Object.keys(COOLIFY_SECRET_TIER).sort()).toEqual([...COOLIFY_SECRET_CLASSES].sort());
    for (const c of COOLIFY_SECRET_CLASSES) expect(["T1", "T2"]).toContain(COOLIFY_SECRET_TIER[c]);
    for (const banned of ["app_key", "ssh_private_key", "coolify_password", "coolify_db"]) expect(COOLIFY_SECRET_CLASSES as readonly string[]).not.toContain(banned);
    expect(COOLIFY_SECRET_TIER.notification).toBe("T2");
    expect(COOLIFY_SECRET_TIER.git_app_key).toBe("T2");
    expect(COOLIFY_SECRET_TIER.deploy_key).toBe("T2");
    expect(COOLIFY_SECRET_TIER.env).toBe("T1");
    expect(unique(COOLIFY_SECRET_REF_KINDS)).toBe(true);
  });

  it("keeps the fixed wire codes, with ok first and no free text", () => {
    expect([...COOLIFY_SECRET_WIRE_CODES]).toEqual(["ok", "bad_mac", "bad_payload", "no_key", "key_prev", "unsupported_cipher", "unsupported_serialization", "column_missing", "too_large"]);
    for (const c of COOLIFY_SECRET_WIRE_CODES) expect(c).toMatch(/^[a-z_]+$/);
  });

  it("bounds the consent windows (secrets 24h default / 7d max, ssh 2h default)", () => {
    expect(COOLIFY_SECRETS_GRANT_DEFAULT_HOURS).toBe(24);
    expect(COOLIFY_SECRETS_GRANT_MAX_HOURS).toBe(168);
    expect(COOLIFY_SSH_GRANT_DEFAULT_HOURS).toBe(2);
    expect(COOLIFY_SSH_GRANT_MAX_HOURS).toBeGreaterThanOrEqual(COOLIFY_SSH_GRANT_DEFAULT_HOURS);
  });

  it("a record is either sealed or a code, never both (the type forbids plaintext fields)", () => {
    const sealed: CoolifySecretRecord = { ref: "env:a", field: "value", class: "env", env: "tse1.AAAA" };
    const failed: CoolifySecretRecord = { ref: "env:a", field: "value", code: "bad_mac" };
    expect("env" in sealed && "code" in sealed).toBe(false);
    expect("code" in failed && "env" in failed).toBe(false);
    // @ts-expect-error a plaintext `value` field is not part of a record
    const leaky: CoolifySecretRecord = { ref: "env:a", field: "value", class: "env", env: "tse1.x", value: "hunter2" };
    expect(leaky).toBeDefined();
  });
});

describe("coolify takeover contract: ssh", () => {
  it("keeps the fixed op and result code sets", () => {
    expect([...COOLIFY_SSH_OPS]).toEqual(["probe", "install", "uninstall"]);
    expect(COOLIFY_SSH_RESULT_CODES).toHaveLength(23);
    expect(unique(COOLIFY_SSH_RESULT_CODES)).toBe(true);
    for (const c of ["hostkey_mismatch", "hostkey_changed", "needs_root", "unsupported_proxy", "enroll_timeout"]) expect(COOLIFY_SSH_RESULT_CODES as readonly string[]).toContain(c);
  });

  it("has the state machine's states, with terminal states a subset", () => {
    expect(unique(COOLIFY_SSH_TARGET_STATES)).toBe(true);
    for (const t of COOLIFY_SSH_TERMINAL_STATES) expect(COOLIFY_SSH_TARGET_STATES).toContain(t);
    expect(COOLIFY_SSH_TERMINAL_STATES).not.toContain("INSTALLING");
    expect(COOLIFY_SSH_TERMINAL_STATES).not.toContain("TOKEN_MINTED");
  });

  it("caps concurrency at 4 per host (max 8) and 8 per hub", () => {
    expect(COOLIFY_SSH_LIMITS.perHostDefault).toBe(4);
    expect(COOLIFY_SSH_LIMITS.perHostMax).toBe(8);
    expect(COOLIFY_SSH_LIMITS.perHub).toBe(8);
    expect(COOLIFY_SSH_LIMITS.perHostDefault).toBeLessThanOrEqual(COOLIFY_SSH_LIMITS.perHostMax);
    expect(COOLIFY_SSH_LIMITS.targetTimeoutMs).toBeLessThan(COOLIFY_SSH_LIMITS.runTimeoutMs);
  });
});

describe("coolify takeover contract: matching", () => {
  it("classes evidence: identity proves, address and hostname do not", () => {
    expect(unique(HOST_EVIDENCE_KINDS)).toBe(true);
    for (const k of ["ssh_host_key", "machine_id", "docker_engine_id"] as const) expect(HOST_EVIDENCE_STRENGTH[k]).toBe("identity");
    expect(HOST_EVIDENCE_STRENGTH.ip).toBe("address");
    expect(HOST_EVIDENCE_STRENGTH.hostname).toBe("weak");
    expect(HOST_EVIDENCE_STRENGTH.cloud_instance_id).toBe("weak");
    expect(Object.keys(HOST_EVIDENCE_STRENGTH).sort()).toEqual([...HOST_EVIDENCE_KINDS].sort());
  });
});

describe("coolify takeover contract: session transport", () => {
  it("has exactly api and agent", () => {
    expect([...IMPORT_TRANSPORTS]).toEqual(["api", "agent"]);
  });

  it("builds and recognises the synthetic agent base URL", () => {
    expect(AGENT_SESSION_URL_PREFIX).toBe("agent://");
    expect(agentSessionBaseUrl("srv_1")).toBe("agent://srv_1");
    expect(isAgentSessionBaseUrl("agent://srv_1")).toBe(true);
    expect(isAgentSessionBaseUrl("agent://")).toBe(false);
    expect(isAgentSessionBaseUrl("https://coolify.example.com")).toBe(false);
    expect(isAgentSessionBaseUrl("")).toBe(false);
    expect(isAgentSessionBaseUrl("AGENT://x")).toBe(false);
  });
});

describe("coolify takeover contract: placement, campaign, takeover, cleanup, project move", () => {
  it("offers exactly in-place and other-server, with the locks the spec names", () => {
    expect([...PLACEMENT_KINDS]).toEqual(["in-place", "other-server"]);
    expect([...PLACEMENT_LOCK_REASONS]).toEqual(["match_uncertain", "agent_offline", "control_plane", "agent_missing"]);
  });

  it("keeps the state lists unique and ordered start to end", () => {
    for (const l of [CAMPAIGN_STATUSES, TAKEOVER_STATUSES, TAKEOVER_CERT_STATES, CLEANUP_STATUSES, COMPLETENESS_KINDS, REMNANT_KINDS, PROJECT_MOVE_PHASES]) expect(unique(l)).toBe(true);
    expect(TAKEOVER_STATUSES[0]).toBe("PLANNED");
    expect(TAKEOVER_STATUSES).toContain("GIVEN_BACK");
    expect(TAKEOVER_CERT_STATES).toEqual(["pending", "fallback", "issued", "failed"]);
    expect(PROJECT_MOVE_PHASES[0]).toBe("QUEUED");
    expect(PROJECT_MOVE_PHASES).toContain("ROLLED_BACK");
  });

  it("the takeover knows compose services: a code for every reason a service is left out or fails, each once", () => {
    expect(unique(TAKEOVER_ISSUES)).toBe(true);
    expect(unique(TAKEOVER_FAILURE_CODES)).toBe(true);
    for (const c of ["service_member_unmapped", "service_member_absent", "service_member_ambiguous", "service_image_differs", "service_image_moved", "service_networks_unmapped", "service_compose_unsupported"]) expect(TAKEOVER_ISSUES).toContain(c);
    for (const c of ["service_not_ready", "service_verify_failed"]) expect(TAKEOVER_FAILURE_CODES).toContain(c);
    // the codes the older kinds already used are still there (a screen string exists for each)
    for (const c of ["db_verify_failed", "container_absent", "volume_unmapped"]) expect(TAKEOVER_ISSUES).toContain(c);
  });

  it("compares the ten things the checklist names (traffic: the domain answers from Tugra)", () => {
    expect([...COMPLETENESS_KINDS]).toEqual(["application", "database", "service", "domain", "traffic", "env_keys", "volume", "scheduled_task", "backup", "notification"]);
    expect([...REMNANT_KINDS]).toEqual(["container", "network", "image", "directory"]);
  });
});
