/**
 * String DI token for ApplicationsService, resolved lazily via ModuleRef from
 * modules that cannot statically import ApplicationsModule without forming a
 * cycle (e.g. ServersModule → ApplicationsModule → AgentGatewayModule →
 * ServersModule). Pure constant — safe to import from anywhere.
 */
export const APPLICATIONS_SERVICE = "APPLICATIONS_SERVICE";

/** String-token alias for ProxyService so ServersService can resolve it lazily (a static import would close an import cycle through the agent gateway). */
export const PROXY_SERVICE = "PROXY_SERVICE";

/** String-token alias for AgentEndpointsService so ServersService can resolve it lazily (the add-server command in IP mode
 *  carries the pinned wss address) without a static import that would close a cycle through the agent gateway. */
export const AGENT_ENDPOINTS_SERVICE = "AGENT_ENDPOINTS_SERVICE";
