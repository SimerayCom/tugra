/** String DI token for lazy ModuleRef resolution of ProvisioningService from ServersService
 *  (destroy-VM on delete) — a type-only import + this token avoid a static module cycle. */
export const PROVISIONING_SERVICE = "PROVISIONING_SERVICE";
