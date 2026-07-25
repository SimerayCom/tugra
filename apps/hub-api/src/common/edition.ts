import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { edition, editionAtLeast, EDITIONS, type Edition } from "@tugra/shared";

export { editionAtLeast, normalizeEdition, EDITIONS, type Edition } from "@tugra/shared";

/** The higher of two editions in the community < pro < cloud ordering. */
function maxEdition(a: Edition, b: Edition): Edition {
  return EDITIONS.indexOf(a) >= EDITIONS.indexOf(b) ? a : b;
}

// The edition granted by a verified signed license (set by LicenseService at boot + on change), with its
// expiry so a license that lapses while the hub runs downgrades on the next read without re-verifying.
// Kept as module state so currentEdition() stays synchronous (it is called per-request in guards).
let licensed: { edition: Edition; expiresAt: number } | null = null;

/**
 * Record (or clear) the edition granted by a verified signed license. Only ever called by LicenseService
 * AFTER an ed25519 signature check — the value here is trusted because the token was cryptographically
 * verified, not because it was written to the DB. `expiresAt` is epoch milliseconds.
 */
export function setLicensedEdition(v: { edition: Edition; expiresAt: number } | null): void {
  licensed = v;
}

/**
 * The instance's effective edition: the HIGHER of the env signal (`TUGRA_EDITION`, injected at build time)
 * and a currently-valid signed license. A license can only RAISE the edition, and only when its ed25519
 * signature verified — so an operator still cannot self-grant Pro/Cloud by flipping a setting or writing
 * the DB (an unsigned/forged token never sets `licensed`). This is the single source of truth read by
 * GET /version, GET /instance/status and the requireEdition gate.
 */
export function currentEdition(): Edition {
  const env = edition();
  if (licensed && licensed.expiresAt > Date.now()) return maxEdition(env, licensed.edition);
  return env;
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
