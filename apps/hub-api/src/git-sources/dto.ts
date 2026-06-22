import { z } from "zod";

export const CreateGitSourceSchema = z.object({
  name: z.string().min(1),
  teamId: z.string().min(1),
  appId: z.string().min(1),
  privateKey: z.string().min(1), // PEM (PKCS#8 / PKCS#1)
  installationId: z.string().min(1).optional(),
  webhookSecret: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  appSlug: z.string().min(1).optional(),
  htmlUrl: z.string().min(1).optional(),
});
export type CreateGitSourceInput = z.infer<typeof CreateGitSourceSchema>;
