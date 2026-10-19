import { PROTOCOL_VERSION, canonicalLogStart, canonicalAgentUpdate, canonicalFs } from "./index";
import type {
  MetricsSample,
  EnrollMsg,
  ContainerMetricsMsg,
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
});
