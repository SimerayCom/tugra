import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { edition, editionAtLeast, type Edition } from "@tugra/shared";

export { editionAtLeast, normalizeEdition, EDITIONS, type Edition } from "@tugra/shared";

/**
 * The instance's current edition. Env-authoritative (`TUGRA_EDITION`, injected at build/license time) —
 * NOT owner-settable, otherwise anyone could unlock Pro/Cloud for free. This is the single source of
 * truth read by GET /version, GET /instance/status and the requireEdition gate.
 */
export function currentEdition(): Edition {
  return edition();
}

export const REQUIRE_EDITION = "require_edition";

/**
 * Gate a route to a minimum edition, e.g. `@RequireEdition("pro")`. NOTE: nothing in the community OSS
 * build carries this decorator (every feature shipped today is community) — applying it to an existing
 * route would 403 it in community. It exists so future Pro/Cloud-only routes can opt in. Enforced by
 * RequireEditionGuard (add it to the route's `@UseGuards(...)`).
 */
export const RequireEdition = (min: Edition) => SetMetadata(REQUIRE_EDITION, min);

@Injectable()
export class RequireEditionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== "http") return true;
    const required = this.reflector.getAllAndOverride<Edition>(REQUIRE_EDITION, [ctx.getHandler(), ctx.getClass()]);
    if (!required) return true; // no gate marked → allowed
    if (!editionAtLeast(currentEdition(), required)) {
      throw new ForbiddenException(`this feature requires the ${required} edition`);
    }
    return true;
  }
}
