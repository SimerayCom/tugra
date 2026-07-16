import { SetMetadata } from "@nestjs/common";
import type { Scope } from "./scopes";

export const REQUIRE_SCOPES = "require_scopes";

/**
 * Override the ScopesGuard's HTTP-method default for a route. Use it where the method doesn't imply the
 * right scope — e.g. a deploy action (`@RequireScopes("deploy")`) or a secret-returning GET
 * (`@RequireScopes("read:secrets")`). All listed scopes must be satisfied.
 */
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(REQUIRE_SCOPES, scopes);
