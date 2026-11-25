import { UnprocessableEntityException } from "@nestjs/common";
import { assertPlacementTargetReady } from "./placement-target";

const code = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UnprocessableEntityException);
    return ((e as UnprocessableEntityException).getResponse() as { code: string }).code;
  }
  return undefined;
};

describe("assertPlacementTargetReady", () => {
  it("accepts an ONLINE server with the deploy capability", () => {
    expect(code(() => assertPlacementTargetReady({ id: "s", status: "ONLINE", capabilities: ["deploy", "backup"] }))).toBeUndefined();
  });
  it("refuses a server whose agent never connected, one that is offline and one without the deploy grant, each with its own code", () => {
    expect(code(() => assertPlacementTargetReady({ id: "s", status: "PENDING", capabilities: ["deploy"] }))).toBe("import.target_pending");
    expect(code(() => assertPlacementTargetReady({ id: "s", status: "OFFLINE", capabilities: ["deploy"] }))).toBe("import.target_offline");
    expect(code(() => assertPlacementTargetReady({ id: "s", status: "ONLINE", capabilities: ["backup"] }))).toBe("import.target_capability");
    expect(code(() => assertPlacementTargetReady({ id: "s", status: "ONLINE", capabilities: [] }))).toBe("import.target_capability");
  });
  it("does not judge a field the row does not report", () => {
    expect(code(() => assertPlacementTargetReady({ id: "s" }))).toBeUndefined();
  });
});
