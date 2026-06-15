import { PROTOCOL_VERSION } from "./index";
import type { MetricsSample, EnrollMsg } from "./index";

describe("shared protocol", () => {
  it("pins the protocol version to 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
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
      token: "tugra_ob_test",
      agentVersion: "0.0.0",
      hostname: "host-1",
    };
    expect(msg.type).toBe("enroll");
    expect(msg.protocol).toBe(1);
  });
});
