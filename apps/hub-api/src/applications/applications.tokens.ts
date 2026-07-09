/**
 * String DI token for ApplicationsService, resolved lazily via ModuleRef from
 * modules that cannot statically import ApplicationsModule without forming a
 * cycle (e.g. ServersModule → ApplicationsModule → AgentGatewayModule →
 * ServersModule). Pure constant — safe to import from anywhere.
 */
export const APPLICATIONS_SERVICE = "APPLICATIONS_SERVICE";
