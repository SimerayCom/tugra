import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RequireEditionGuard, currentEdition, setLicensedEdition, type Edition } from "./edition";

// currentEdition() reads TUGRA_EDITION at call time — set/clear it per test (version.spec pattern).
const ORIGINAL = process.env.TUGRA_EDITION;
afterEach(() => {
  setLicensedEdition(null); // clear the module-level licensed cache between tests
  if (ORIGINAL === undefined) delete process.env.TUGRA_EDITION;
  else process.env.TUGRA_EDITION = ORIGINAL;
});

const HOUR = 3600_000;

function ctx(type = "http"): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function guard(required: Edition | undefined): RequireEditionGuard {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  return new RequireEditionGuard(reflector);
}

describe("currentEdition", () => {
  it("reads TUGRA_EDITION, defaulting unknown/unset to community", () => {
    delete process.env.TUGRA_EDITION;
    expect(currentEdition()).toBe("community");
    process.env.TUGRA_EDITION = "pro";
    expect(currentEdition()).toBe("pro");
    process.env.TUGRA_EDITION = "enterprise";
    expect(currentEdition()).toBe("community");
  });

  it("a valid licensed edition RAISES the env edition (community + pro license → pro)", () => {
    delete process.env.TUGRA_EDITION;
    setLicensedEdition({ edition: "pro", expiresAt: Date.now() + HOUR });
    expect(currentEdition()).toBe("pro");
  });

  it("never LOWERS the env edition (cloud env + pro license → cloud)", () => {
    process.env.TUGRA_EDITION = "cloud";
    setLicensedEdition({ edition: "pro", expiresAt: Date.now() + HOUR });
    expect(currentEdition()).toBe("cloud");
  });

  it("an expired licensed edition is ignored (falls back to env)", () => {
    delete process.env.TUGRA_EDITION;
    setLicensedEdition({ edition: "cloud", expiresAt: Date.now() - HOUR });
    expect(currentEdition()).toBe("community");
  });

  it("clearing the license (null) falls back to env", () => {
    delete process.env.TUGRA_EDITION;
    setLicensedEdition({ edition: "pro", expiresAt: Date.now() + HOUR });
    setLicensedEdition(null);
    expect(currentEdition()).toBe("community");
  });
});

describe("RequireEditionGuard", () => {
  it("allows a route with no @RequireEdition marker (no gate)", () => {
    delete process.env.TUGRA_EDITION; // community
    expect(guard(undefined).canActivate(ctx())).toBe(true);
  });

  it("blocks a pro-gated route in the community edition", () => {
    delete process.env.TUGRA_EDITION;
    expect(() => guard("pro").canActivate(ctx())).toThrow(ForbiddenException);
  });

  it("allows a pro-gated route in pro and cloud editions", () => {
    process.env.TUGRA_EDITION = "pro";
    expect(guard("pro").canActivate(ctx())).toBe(true);
    process.env.TUGRA_EDITION = "cloud";
    expect(guard("pro").canActivate(ctx())).toBe(true);
  });

  it("blocks a cloud-gated route in pro", () => {
    process.env.TUGRA_EDITION = "pro";
    expect(() => guard("cloud").canActivate(ctx())).toThrow(ForbiddenException);
  });

  it("passes through non-http contexts", () => {
    process.env.TUGRA_EDITION = "community";
    expect(guard("cloud").canActivate(ctx("ws"))).toBe(true);
  });
});
