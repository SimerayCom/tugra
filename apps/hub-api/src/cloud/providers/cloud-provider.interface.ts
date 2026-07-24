export interface CloudServerCreateOpts {
  name: string;
  location: string; // curated catalog key, e.g. "nbg1"
  serverType: string; // curated catalog key, e.g. "cx22"
  image: string; // curated catalog key, e.g. "ubuntu-24.04"
  userData: string; // cloud-init script — carries the enroll token, NEVER the provider API token
}

export interface CloudServerCreateResult {
  providerServerId: string;
  publicIp: string | null;
  publicIpv6: string | null;
}

/**
 * A cloud provider (Hetzner in v1; DigitalOcean/Vultr later). Every method takes the API token
 * EXPLICITLY — it is never stored on the instance — and no method interpolates the token into a
 * thrown/logged message (a leaked exception must never reveal the credential from request headers).
 */
export interface CloudProvider {
  readonly name: string;
  /** True when the token authenticates; false on 401/403; throws on other/network errors. */
  verifyToken(token: string): Promise<{ valid: boolean }>;
  createServer(token: string, opts: CloudServerCreateOpts): Promise<CloudServerCreateResult>;
  /** Idempotent — an already-gone (404) VM resolves normally (best-effort teardown). */
  destroyServer(token: string, providerServerId: string): Promise<void>;
}
