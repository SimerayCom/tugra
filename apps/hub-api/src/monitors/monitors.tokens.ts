/**
 * String DI token for MonitorsService, resolved lazily via ModuleRef from modules
 * that cannot statically import MonitorsModule without risking a cycle (ServersModule
 * auto-creates a per-server disk monitor on enroll and tears it down on delete). Pure
 * constant — safe to import from anywhere.
 */
export const MONITORS_SERVICE = "MONITORS_SERVICE";
