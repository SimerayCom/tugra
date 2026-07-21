import { z } from "zod";
import { DOMAIN_RE } from "../../applications/dto";

/**
 * Connect a server to Cloudflare Tunnel. `wildcardDomain` defaults to `zoneName`
 * and must be the zone or a subdomain of it (validated in the service). The API
 * token is a secret — encrypted at rest, never returned.
 */
export const SetupTunnelSchema = z.object({
  apiToken: z.string().trim().min(20).max(500),
  cfAccountId: z.string().trim().min(1).max(64),
  zoneName: z.string().trim().max(253).regex(DOMAIN_RE, "invalid domain"),
  wildcardDomain: z.string().trim().max(253).regex(DOMAIN_RE, "invalid domain").optional(),
});
export type SetupTunnelInput = z.infer<typeof SetupTunnelSchema>;

/** Per-app opt-in: route this app's hostname through its server's Cloudflare Tunnel. */
export const SetAppTunnelSchema = z.object({ exposed: z.boolean() });
export type SetAppTunnelInput = z.infer<typeof SetAppTunnelSchema>;

/** Read model for a server's tunnel. Secrets (cfApiTokenEnc/cfTunnelTokenEnc) are NEVER included. */
export interface TunnelView {
  configured: boolean;
  provider: string | null;
  zoneName: string | null;
  wildcardDomain: string | null;
  tunnelId: string | null;
  status: string | null;
  lastError: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}
