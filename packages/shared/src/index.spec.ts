import {
  canonicalCommand,
  canonicalCommandCancel,
  canonicalCommandStatus,
  AGENT_FEATURE_CMD_JOURNAL,
  AGENT_FEATURE_LOG_DRAINS_V2,
  AGENT_FEATURE_DRAIN_SYSLOG,
  AGENT_FEATURE_DRAIN_GELF,
  AGENT_FEATURE_DRAIN_FLUENTD,
  canonicalLogDrains,
  AGENT_FEATURE_FS2,
  AGENT_CAPABILITIES,
  FS_ERROR_CODES,
  canonicalFs2,
  fs2RequiredCapabilities,
  PROTOCOL_VERSION, TRAFFIC_LATENCY_BUCKETS_MS, canonicalLogStart, canonicalAgentUpdate, canonicalFs } from "./index";
import type {
  Fs2Fields,
  MetricsSample,
  EnrollMsg,
  ContainerMetricsMsg,
  TrafficMetricsMsg,
  TrafficDomainStat,
  AgentMessage,
  HubMessage,
  LogStartMsg,
  LogChunkMsg,
  AgentCapability,
  AgentUpdateMsg,
  AgentUpdateResultMsg,
} from "./index";

describe("shared protocol", () => {
  it("pins the protocol version to 2", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("shapes a metrics sample", () => {
    const sample: MetricsSample = {
      ts: 1,
      cpu: 12.5,
      memUsed: 100,
      memTotal: 200,
      diskUsed: 10,
      diskTotal: 50,
      netRx: 0,
      netTx: 0,
      diskRead: 0,
      diskWrite: 0,
    };
    expect(sample.cpu).toBeLessThanOrEqual(100);
  });

  it("shapes an enroll message", () => {
    const msg: EnrollMsg = {
      type: "enroll",
      protocol: PROTOCOL_VERSION,
      token: "tugra_en_test",
      publicKey: "base64spki",
      agentVersion: "0.0.0",
      hostname: "host-1",
      fingerprint: "fp",
    };
    expect(msg.type).toBe("enroll");
    expect(msg.protocol).toBe(2);
  });

  it("builds a byte-stable canonicalLogStart (must match the Go agent)", () => {
    // Fixed newline-delimited format; the Go agent's CanonicalLogStart must be byte-identical.
    expect(canonicalLogStart("sid1", "tugra_app1", 200, true, "1h", "err", "logs")).toBe(
      "logs\nsid1\ntugra_app1\n200\n1\n1h\nerr\nlogs",
    );
    // empty since/search still occupy their delimited slots
    expect(canonicalLogStart("sid1", "c", 50, false, "", "", "logs")).toBe("logs\nsid1\nc\n50\n0\n\n\nlogs");
  });

  it("builds a byte-stable canonicalAgentUpdate (must match the Go agent's CanonicalAgentUpdate)", () => {
    // Any drift from the Go builder → every signed agent_update is rejected. Keep this fixture identical
    // to protocol_test.go's CanonicalAgentUpdate assertion.
    expect(canonicalAgentUpdate("r1", "0.2.0", "ghcr.io/simeraycom/tugra-agent:0.2.0", "deadbeef", "deploy")).toBe(
      "aupd\nr1\n0.2.0\nghcr.io/simeraycom/tugra-agent:0.2.0\ndeadbeef\ndeploy",
    );
  });

  it("builds a byte-stable canonicalFs (must match the Go agent's CanonicalFs)", () => {
    // Any drift from the Go builder → every signed fs_req is rejected. Keep this fixture identical
    // to protocol_test.go's CanonicalFs assertion.
    expect(canonicalFs("r1", "list", "tugra_appv_x_data", "sub/dir", "files")).toBe(
      "fs\nr1\nlist\ntugra_appv_x_data\nsub/dir\nfiles",
    );
  });

  it("shapes the agent_update messages + unions (additive, no version bump)", () => {
    const up: AgentUpdateMsg = {
      type: "agent_update",
      reqId: "r1",
      targetVersion: "0.2.0",
      image: "ghcr.io/simeraycom/tugra-agent:0.2.0",
      sha256: "deadbeef",
      capability: "deploy",
      sig: "SIG",
    };
    const res: AgentUpdateResultMsg = { type: "agent_update_result", reqId: "r1", targetVersion: "0.2.0", ok: false, phase: "pull", error: "boom" };
    const hub: HubMessage = up;
    const agent: AgentMessage = res;
    expect(hub.type).toBe("agent_update");
    expect(agent.type).toBe("agent_update_result");
  });

  it("shapes the live-log messages and unions (additive, no version bump)", () => {
    const start: LogStartMsg = { type: "log_start", streamId: "s", target: "c", tail: 200, follow: true, capability: "logs", sig: "SIG" };
    const chunk: LogChunkMsg = { type: "log_chunk", streamId: "s", chunk: "hello\n" };
    const asHub: HubMessage = start; // hub -> agent
    const asAgent: AgentMessage = chunk; // agent -> hub
    const cap: AgentCapability = "logs"; // new read-only capability
    expect(asHub.type).toBe("log_start");
    expect(asAgent.type).toBe("log_chunk");
    expect(cap).toBe("logs");
    expect(PROTOCOL_VERSION).toBe(2); // additive: no bump
  });

  it("shapes a container_metrics message (additive, no version bump)", () => {
    const msg: ContainerMetricsMsg = {
      type: "container_metrics",
      ts: 1_700_000_000_000,
      samples: [
        { id: "abc123", name: "web", cpu: 0.15, memUsed: 100, memTotal: 200, memPct: 0.5, netRx: 10, netTx: 20, blkRead: 0, blkWrite: 5 },
      ],
    };
    // assignable to the AgentMessage union (agent -> hub)
    const asAgentMsg: AgentMessage = msg;
    expect(asAgentMsg.type).toBe("container_metrics");
    expect(msg.samples[0].name).toBe("web");
    // additive: the protocol version must NOT change for a new agent->hub message type
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("shapes a traffic_metrics message (additive, countries optional, no version bump)", () => {
    const msg: TrafficMetricsMsg = {
      type: "traffic_metrics",
      ts: 1_700_000_000_000,
      windowSec: 60,
      domains: [
        { host: "a.example.com", requests: 3, s2xx: 2, s3xx: 0, s4xx: 1, s5xx: 0, bytes: 900, paths: [{ p: "/", n: 3, b: 900 }] },
        { host: "b.example.com", requests: 1, s2xx: 1, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 10, paths: [], countries: [{ c: "TR", n: 1 }] },
      ],
    };
    const asAgentMsg: AgentMessage = msg;
    expect(asAgentMsg.type).toBe("traffic_metrics");
    expect(msg.domains[0].countries).toBeUndefined();
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("extends TrafficDomainStat with optional aggregate-only dimensions (additive, no version bump)", () => {
    expect(TRAFFIC_LATENCY_BUCKETS_MS).toHaveLength(13);
    expect([...TRAFFIC_LATENCY_BUCKETS_MS]).toEqual([1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
    const latency = new Array(TRAFFIC_LATENCY_BUCKETS_MS.length + 1).fill(0);
    latency[3] = 2;
    const d: TrafficDomainStat = {
      host: "a.example.com", requests: 2, s2xx: 2, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 10, paths: [],
      browsers: [{ k: "Chrome", n: 2 }],
      os: [{ k: "Windows", n: 2 }],
      devices: [{ k: "desktop", n: 2 }],
      referrers: [{ k: "(direct)", n: 2 }],
      cities: [{ k: "Istanbul", n: 1 }],
      networks: [{ k: "1.2.3.0/24", n: 2 }],
      bots: { human: 2, bot: 0 },
      latency,
    };
    const msg: TrafficMetricsMsg = { type: "traffic_metrics", ts: 1, windowSec: 60, domains: [d] };
    expect(msg.domains[0].latency).toHaveLength(14);
    expect(msg.domains[0].unique).toBeUndefined(); // optional HyperLogLog sketch (base64, 4096 bytes)
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("canonicalCommandStatus is byte-identical to the Go agent's CanonicalCommandStatus and distinct from cancel", () => {
    expect(canonicalCommandStatus("r1")).toBe("cstat\nr1");
    expect(canonicalCommandStatus("r1")).not.toBe(canonicalCommandCancel("r1"));
    expect(AGENT_FEATURE_CMD_JOURNAL).toBe("cmd_journal_v1");
    // the durable flag is NOT signed: canonicalCommand's input is unchanged by it
    expect(canonicalCommand("r1", "echo hi", 5000, "deploy")).toBe("cmd\nr1\necho hi\n5000\ndeploy");
  });

  it("canonicalLogDrains golden is byte-identical to the Go agent's CanonicalLogDrains", () => {
    expect(canonicalLogDrains("srv1", 1731672000000, '[{"id":"d1"}]', "logs")).toBe(
      'ldrn\nsrv1\n1731672000000\n[{"id":"d1"}]\nlogs',
    );
    // the serverId is bound into the signed bytes (replay to another server changes them)
    expect(canonicalLogDrains("srv2", 1, "[]", "logs")).not.toBe(canonicalLogDrains("srv1", 1, "[]", "logs"));
  });

  it("pins the log-drain feature flag names", () => {
    expect(AGENT_FEATURE_LOG_DRAINS_V2).toBe("log_drains_v2");
    expect(AGENT_FEATURE_DRAIN_SYSLOG).toBe("log_drain_syslog_v1");
    expect(AGENT_FEATURE_DRAIN_GELF).toBe("log_drain_gelf_v1");
    expect(AGENT_FEATURE_DRAIN_FLUENTD).toBe("log_drain_fluentd_v1");
  });
});

describe("fs2 protocol", () => {
  // Pinned identically in agent/internal/protocol/protocol_test.go (TestCanonicalFs2Golden). Any drift => every
  // signed fs2_req is rejected by the agent.
  const golden: Fs2Fields = {
    reqId: "00000000-0000-4000-8000-000000000001",
    op: "write",
    scope: "volume",
    subject: "tugra_appv_c1_data",
    path: "dir/h\u00e9llo\n.txt",
    path2: "",
    mode: "0644",
    flags: "o",
    size: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    ifMatch: "",
    xfer: "/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1800000000&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
    timeoutMs: 30000,
    exp: 1800000000,
    capability: "files_write",
  };
  const goldenCanonical =
    "fs2\n36:00000000-0000-4000-8000-000000000001\n5:write\n6:volume\n18:tugra_appv_c1_data\n15:dir/h\u00e9llo\n.txt\n0:\n4:0644\n1:o\n1:5\n64:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\n0:\n87:/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1800000000&sig=BBBBBBBBBBBBBBBBBBBBBBBB\n5:30000\n10:1800000000\n11:files_write";

  it("builds the pinned golden canonical string (byte-identical to the Go CanonicalFs2)", () => {
    expect(canonicalFs2(golden)).toBe(goldenCanonical);
  });

  it("covers every field: tampering any one changes the signed string", () => {
    const base = canonicalFs2(golden);
    const tampered: Fs2Fields[] = [
      { ...golden, reqId: "00000000-0000-4000-8000-000000000002" },
      { ...golden, op: "mkdir" },
      { ...golden, scope: "container" },
      { ...golden, subject: "tugra_appv_c1_data2" },
      { ...golden, path: "dir/other" },
      { ...golden, path2: "x" },
      { ...golden, mode: "0600" },
      { ...golden, flags: "or" },
      { ...golden, size: 6 },
      { ...golden, sha256: "0".repeat(64) },
      { ...golden, ifMatch: "5-1" },
      { ...golden, xfer: "" },
      { ...golden, timeoutMs: 30001 },
      { ...golden, exp: 1800000001 },
      { ...golden, capability: "files" },
    ];
    expect(tampered).toHaveLength(Object.keys(golden).length);
    for (const t of tampered) expect(canonicalFs2(t)).not.toBe(base);
  });

  it("cannot be forged by an embedded newline (length prefix, not a delimiter)", () => {
    // Under a plain newline join, path="a\nb"+path2="" and path="a"+path2="b" would render alike.
    const a = canonicalFs2({ ...golden, path: "a\nb", path2: "" });
    const b = canonicalFs2({ ...golden, path: "a", path2: "b" });
    const c = canonicalFs2({ ...golden, path: "a\n1:b", path2: "" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("derives the required capability set per (scope, op) exactly as the matrix says", () => {
    expect(fs2RequiredCapabilities("volume", "stat")).toEqual(["files"]);
    expect(fs2RequiredCapabilities("volume", "read")).toEqual(["files"]);
    for (const op of ["write", "mkdir", "rename", "chmod", "delete"] as const) {
      expect(fs2RequiredCapabilities("volume", op)).toEqual(["files", "files_write"]);
      expect(fs2RequiredCapabilities("container", op)).toEqual(["files", "files_write", "terminal"]);
    }
    for (const op of ["list", "stat", "read"] as const) {
      expect(fs2RequiredCapabilities("container", op)).toEqual(["files", "terminal"]);
    }
    // volume list is NOT an fs2 op (legacy fs_req keeps it) => empty = unknown
    expect(fs2RequiredCapabilities("volume", "list")).toEqual([]);
  });

  it("ships files_write as an opt-in capability and a closed error-code set", () => {
    expect(AGENT_CAPABILITIES).toContain("files_write");
    expect(AGENT_CAPABILITIES.indexOf("files_write")).toBe(AGENT_CAPABILITIES.indexOf("files") + 1);
    expect(AGENT_FEATURE_FS2).toBe("fs2_v1");
    expect([...FS_ERROR_CODES]).toEqual([
      "not_found", "exists", "not_dir", "is_dir", "not_regular", "not_empty", "denied", "read_only", "no_space",
      "too_large", "changed", "integrity", "bad_request", "unsupported", "not_configured", "busy", "expired",
      "not_running", "no_binary", "failed",
    ]);
  });
});
