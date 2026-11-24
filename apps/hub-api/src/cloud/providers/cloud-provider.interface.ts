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

/** Out-of-band power actions that work whether or not the Tugra agent is alive. `reboot` is a HARD reset
 *  (cut power and start again) and `power_off` cuts power: both can lose unflushed data, so the service
 *  requires a typed confirmation for them. `shutdown` is the graceful (ACPI) stop. */
export const OOB_POWER_ACTIONS = ["power_on", "power_off", "reboot", "shutdown"] as const;
export type OobPowerAction = (typeof OOB_POWER_ACTIONS)[number];

/** The provider-side view of one VM (never carries a credential). */
export interface ProviderServerState {
  providerServerId: string;
  name: string;
  /** Provider status word, e.g. running | off | starting | stopping | rebuilding | migrating | initializing. */
  status: string;
  locked: boolean;
  rescueEnabled: boolean;
  publicIpv4: string | null;
  publicIpv6: string | null;
}

/** The provider-side action a call started. `status` is "running" while the provider works on it. */
export interface ProviderActionResult {
  id: string;
  status: "running" | "success" | "error";
  command: string;
}

export interface EnableRescueResult {
  action: ProviderActionResult;
  /** One-time root password of the rescue system. Shown once; never stored or logged by Tugra. */
  rootPassword: string;
}

export interface ConsoleSession {
  action: ProviderActionResult;
  /** Short-lived websocket URL of the provider's VNC proxy (carries a token). Shown once. */
  wssUrl: string;
  /** VNC password for that URL. Shown once; never stored or logged by Tugra. */
  password: string;
  /** How long the URL stays valid for a first connect. */
  validForSeconds: number;
}

/**
 * Providers that can act on a VM without its agent: power, rescue, console. Same contract as CloudProvider
 * (the token is an explicit argument, never kept, never in a thrown message). Hetzner is the first.
 */
export interface CloudOobProvider {
  readonly name: string;
  /** Read one VM. A 404 throws (the VM is gone or belongs to another project). */
  getServerState(token: string, providerServerId: string): Promise<ProviderServerState>;
  /** The VMs of the token's project (first pages only: bounded). */
  listServers(token: string): Promise<ProviderServerState[]>;
  power(token: string, providerServerId: string, action: OobPowerAction): Promise<ProviderActionResult>;
  enableRescue(token: string, providerServerId: string): Promise<EnableRescueResult>;
  disableRescue(token: string, providerServerId: string): Promise<ProviderActionResult>;
  requestConsole(token: string, providerServerId: string): Promise<ConsoleSession>;
}

/** A provider plan (server type) with the resources it offers; the disk of an existing VM never shrinks. */
export interface ProviderPlanSpec {
  slug: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  /** "x86" | "arm": a VM cannot move between architectures. */
  architecture: string;
}

/** One cloud VM with the plan it runs and what that plan costs per month at its location (excluding VAT). */
export interface ProviderServerPlan {
  providerServerId: string;
  plan: ProviderPlanSpec;
  location: string | null;
  /** Integer cents, or null when the provider did not price that plan at that location. */
  monthlyCents: number | null;
  currency: string;
}

/** A plan that can be ordered, priced per location (cents per month, excluding VAT). */
export interface ProviderPlan extends ProviderPlanSpec {
  deprecated: boolean;
  monthlyCentsByLocation: Record<string, number>;
  currency: string;
}

/**
 * Providers whose API reports plan prices and can change a VM's plan. Same contract as CloudProvider: the token is an
 * explicit argument, never kept, never in a thrown message. Hetzner is the first.
 */
export interface CloudPlanProvider {
  readonly name: string;
  /** The VMs of the token's project with the plan they run and its price (first pages only: bounded). */
  listServerPlans(token: string): Promise<ProviderServerPlan[]>;
  /** The plans one can switch to, with prices per location. */
  listPlanCatalog(token: string): Promise<ProviderPlan[]>;
  getServerPlan(token: string, providerServerId: string): Promise<ProviderServerPlan>;
  /** Change the plan of a VM that is powered off. `upgradeDisk` false keeps the disk size (the move stays reversible). */
  changeType(token: string, providerServerId: string, planSlug: string, upgradeDisk: boolean): Promise<ProviderActionResult>;
}
