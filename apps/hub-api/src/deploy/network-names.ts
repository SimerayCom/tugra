/**
 * Reserved Docker network names + the shared per-server app bridge. Pure (no imports) so the DTO, the
 * service and deploy-script can all use it without an import cycle.
 */
export const APPS_NETWORK = "tugra-apps";

// Docker built-ins + every Tugra-managed network except tugra-apps. Literal copies; network-names.spec guards drift.
export const RESERVED_NETWORK_NAMES: ReadonlySet<string> = new Set([
  "bridge",
  "host",
  "none",
  "default",
  "ingress",
  "docker_gwbridge",
  "tugra-proxy",
  "tugra-net",
  "tugra-swarm",
  "tugra-panel",
]);

export function isUserNetworkNameAllowed(n: string): boolean {
  if (n === APPS_NETWORK) return true;
  return !RESERVED_NETWORK_NAMES.has(n) && !/^tugra[-_]/i.test(n);
}
