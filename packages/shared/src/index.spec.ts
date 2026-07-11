import { PROTOCOL_VERSION, canonicalLogStart } from "./index";
import type {
  MetricsSample,
  EnrollMsg,
  ContainerMetricsMsg,
  AgentMessage,
  HubMessage,
  LogStartMsg,
  LogChunkMsg,
  AgentCapability,
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
    expect(canonicalLogStart("sid1", "tugra_app1", 200, true, "logs")).toBe(
      "logs\nsid1\ntugra_app1\n200\n1\nlogs",
    );
    expect(canonicalLogStart("sid1", "c", 50, false, "logs")).toBe("logs\nsid1\nc\n50\n0\nlogs");
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
