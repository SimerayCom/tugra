import { PROTOCOL_VERSION, TRAFFIC_LATENCY_BUCKETS_MS, canonicalLogStart, canonicalAgentUpdate, canonicalFs } from "./index";
import type {
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
    expect(msg.domains[0].unique).toBeUndefined(); // reserved for the HyperLogLog slice
    expect(PROTOCOL_VERSION).toBe(2);
  });
});
