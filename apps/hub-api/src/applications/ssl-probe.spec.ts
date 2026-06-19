import { sslState, probeSsl } from "./ssl-probe";

describe("ssl-probe", () => {
  it("classifies cert lifetime by days remaining", () => {
    expect(sslState(90)).toBe("ok");
    expect(sslState(15)).toBe("ok");
    expect(sslState(14)).toBe("expiring");
    expect(sslState(0)).toBe("expiring");
  });

  it("returns an error state for an unresolvable host (graceful)", async () => {
    const r = await probeSsl("nonexistent.invalid.tugra-test", 1000);
    expect(r.state).toBe("error");
    expect(r.daysRemaining).toBeNull();
  });
});
