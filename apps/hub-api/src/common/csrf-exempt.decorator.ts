import { SetMetadata } from "@nestjs/common";

export const CSRF_EXEMPT = "csrf_exempt";

/**
 * Marks a route as exempt from double-submit CSRF. Use on PUBLIC, non-cookie-authenticated
 * endpoints (login/register/forgot/reset) — they authenticate from the request body, not from the
 * session cookie, so CSRF enforcement there only serves to lock out a browser that happens to still
 * carry a stale session cookie (SameSite=Lax already covers login-CSRF for the new session).
 */
export const CsrfExempt = () => SetMetadata(CSRF_EXEMPT, true);
