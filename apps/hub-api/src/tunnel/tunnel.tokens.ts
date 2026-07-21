/**
 * String DI token for TunnelService, resolved lazily via ModuleRef from modules
 * that cannot statically import TunnelModule without forming a cycle (e.g.
 * ServersService.deleteForUser → TunnelService for orphan cleanup). Pure constant.
 */
export const TUNNEL_SERVICE = "TUNNEL_SERVICE";
