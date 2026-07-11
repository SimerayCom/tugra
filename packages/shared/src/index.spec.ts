import { PROTOCOL_VERSION } from "./index";
import type { MetricsSample, EnrollMsg, ContainerMetricsMsg, AgentMessage } from "./index";

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
