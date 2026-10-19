import { z } from "zod";
import { DOMAIN_RE } from "../../applications/dto";

export const CreateServerSchema = z.object({
  name: z.string().min(1),
  teamId: z.string().min(1),
});
export type CreateServerInput = z.infer<typeof CreateServerSchema>;

// Granted agent capabilities the hub will sign commands for on this server.
export const SetCapabilitiesSchema = z.object({
  capabilities: z.array(z.enum(["deploy", "database", "backup", "cleanup", "bulk", "terminal", "schedule", "patch", "logs"])),
});
export type SetCapabilitiesInput = z.infer<typeof SetCapabilitiesSchema>;

// Per-server network settings: a manual public-IP pin (null → resume observing),
// a magic-domain wildcard root, and a magic suffix override. IP reachability is
// validated in the service (isPublicIp); domains are lenient hostnames.
export const NetworkSettingsSchema = z
  .object({
    publicIp: z.string().trim().max(45).nullable().optional(),
    publicIpv6: z.string().trim().max(45).nullable().optional(),
    wildcardDomain: z.string().trim().max(253).regex(DOMAIN_RE, "invalid domain").nullable().optional(),
    magicSuffix: z.string().trim().max(253).regex(DOMAIN_RE, "invalid domain").nullable().optional(),
    // Wildcard cert policy + DNS-01 provider. dnsCreds is the plaintext provider env
    // map (encrypted server-side, never returned); a null clears the stored creds.
    certMode: z.enum(["http", "le-dns", "custom"]).optional(),
    dnsProvider: z.string().trim().max(64).nullable().optional(),
    dnsCreds: z.record(z.string()).nullable().optional(),
    customCertResolver: z.string().trim().max(64).nullable().optional(),
    // How the reverse proxy publishes :80/:443 (CASA-INSTALL-5). Takes effect when the proxy is RECREATED —
    // the next deploy of a domained app, or a proxy Start — NOT on a plain proxy Restart (which keeps the
    // running container's port bindings).
    proxyBind: z.enum(["public", "loopback", "none"]).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "provide at least one field" });
export type NetworkSettingsInput = z.infer<typeof NetworkSettingsSchema>;
