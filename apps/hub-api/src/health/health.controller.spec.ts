import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("reports ok with the service name and protocol version", () => {
    const result = new HealthController().check();

    expect(result.status).toBe("ok");
    expect(result.service).toBe("tugra-hub-api");
    expect(typeof result.version).toBe("string");
    expect(result.protocol).toBe(2);
    expect(typeof result.time).toBe("string");
  });
});
