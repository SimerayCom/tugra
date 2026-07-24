import { z } from "zod";

export const CreateCloudCredentialSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(["hetzner", "digitalocean", "vultr"]), // only hetzner has a client in v1
  apiToken: z.string().min(1),
});
export type CreateCloudCredentialInput = z.infer<typeof CreateCloudCredentialSchema>;

export const UpdateCloudCredentialSchema = z.object({
  name: z.string().min(1).optional(),
  apiToken: z.string().min(1).optional(), // write-only; only re-encrypted (and re-verified) when supplied
});
export type UpdateCloudCredentialInput = z.infer<typeof UpdateCloudCredentialSchema>;

export const ProvisionServerSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1).max(100),
  cloudCredentialId: z.string().min(1),
  provider: z.literal("hetzner"), // v1: only hetzner; shaped for more providers later
  location: z.string().min(1),
  serverType: z.string().min(1),
  image: z.string().min(1).optional(),
});
export type ProvisionServerInput = z.infer<typeof ProvisionServerSchema>;
