import { SetMetadata } from "@nestjs/common";

export const ALLOW_UNVERIFIED = "allow_unverified";

/**
 * Marks a route (or a whole controller) as reachable by users whose email isn't verified yet, even
 * when REQUIRE_EMAIL_VERIFICATION is on. Use on account self-service (verify, resend, logout, profile
 * update, change password, 2FA) so an unverified user can still fix their email and confirm it.
 */
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED, true);
