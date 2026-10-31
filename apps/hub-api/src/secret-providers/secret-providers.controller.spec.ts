import "reflect-metadata";
import { SecretProvidersController } from "./secret-providers.controller";
import { ApplicationsController } from "../applications/applications.controller";
import { REQUIRE_EDITION } from "../common/edition";

/**
 * The secret-store feature is open-core governance: CONFIGURING a provider (create/update/test) and BINDING a
 * secret to an app are Pro-only. A silent un-gating (removing the decorator) would be a monetization
 * regression, so assert both the @RequireEdition("pro") metadata AND that RequireEditionGuard is actually
 * attached (metadata alone enforces nothing). SetMetadata/@UseGuards store on the method function itself.
 */
function handler(proto: object, method: string): object {
  return (proto as Record<string, unknown>)[method] as object;
}
function assertProGated(proto: object, method: string) {
  expect(Reflect.getMetadata(REQUIRE_EDITION, handler(proto, method))).toBe("pro");
  const guards: unknown[] = Reflect.getMetadata("__guards__", handler(proto, method)) ?? [];
  expect(guards.map((g) => (g as { name: string }).name)).toContain("RequireEditionGuard");
}

describe("secret-store Pro gating", () => {
  it("gates provider create/update/test to Pro", () => {
    assertProGated(SecretProvidersController.prototype, "create");
    assertProGated(SecretProvidersController.prototype, "update");
    assertProGated(SecretProvidersController.prototype, "test");
  });

  it("gates binding a secret to an app (bindSecret) to Pro", () => {
    assertProGated(ApplicationsController.prototype, "bindSecret");
  });

  it("leaves list/delete/unbind OPEN (a downgraded instance can still see + remove)", () => {
    expect(Reflect.getMetadata(REQUIRE_EDITION, handler(SecretProvidersController.prototype, "list"))).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_EDITION, handler(SecretProvidersController.prototype, "remove"))).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_EDITION, handler(ApplicationsController.prototype, "listSecretRefs"))).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_EDITION, handler(ApplicationsController.prototype, "unbindSecret"))).toBeUndefined();
  });
});
