// The web container is the middle hop of the panel chain: browser -> reverse proxy (Traefik) -> web (Next) -> hub.
// Next's rewrite proxy and the streaming route handlers forward the client's headers VERBATIM and never add the
// address of the peer they accepted the connection from, so without a guard a client that reaches the web port could
// hand the hub any X-Forwarded-For it likes (the hub trusts the web container, a private peer, to speak for the
// client) and a client-supplied CF-Connecting-IP would ride along unchecked. This guard runs on the raw request,
// where the socket is visible, and rewrites the chain so the hub only ever receives one it can believe. The trust
// rules are the hub's own (@tugra/shared), driven by the same HUB_TRUSTED_PROXY* variables.
import * as sharedNs from "@tugra/shared";

// @tugra/shared is CommonJS: Node's ESM loader exposes its exports as named bindings and also under `default`, other
// loaders (Vite's SSR transform, used by the unit tests) only under `default`. Take whichever carries the functions.
const shared = typeof sharedNs.sanitizeForwardedChain === "function" ? sharedNs : sharedNs.default;
const { parseCidrList, sanitizeForwardedChain } = shared;

/**
 * Build the trust policy from the environment (the same variables the hub reads). Fail closed: strict mode with no
 * usable CIDR trusts nobody, so every request is attributed to its own socket address.
 * @param {Record<string, string | undefined>} env
 */
export function clientIpPolicyFromEnv(env = process.env) {
  const trustedCidrs = parseCidrList(env.HUB_TRUSTED_PROXY_CIDRS);
  return {
    trustProxy: env.HUB_TRUSTED_PROXY === "true",
    strict: env.HUB_TRUSTED_PROXY_STRICT === "true",
    trustedCidrs,
  };
}

/**
 * Rewrite the forwarding headers of an incoming request in place, before Next sees it.
 *  - X-Forwarded-For becomes ONE entry: the address a trusted proxy peer observed, else the socket peer itself.
 *  - CF-Connecting-IP survives only when that trusted chain delivered it (the hub still verifies the Cloudflare hop).
 *  - X-Real-IP and Forwarded are dropped: the hub does not read them and a client must not be able to plant them.
 * @param {{ headers: Record<string, string | string[] | undefined>, socket?: { remoteAddress?: string } | null }} req
 * @param {ReturnType<typeof clientIpPolicyFromEnv>} policy
 */
export function guardForwardedHeaders(req, policy) {
  const raw = req.headers["x-forwarded-for"];
  const xff = Array.isArray(raw) ? raw.join(", ") : raw;
  const chain = sanitizeForwardedChain(req.socket?.remoteAddress, xff, policy);
  req.headers["x-forwarded-for"] = chain.forwardedFor;
  if (!chain.keepCfConnectingIp) delete req.headers["cf-connecting-ip"];
  delete req.headers["x-real-ip"];
  delete req.headers["forwarded"];
}
