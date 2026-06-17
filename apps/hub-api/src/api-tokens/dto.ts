import { z } from "zod";

export const CreateApiTokenSchema = z.object({
  name: z.string().min(1).max(100),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateApiTokenInput = z.infer<typeof CreateApiTokenSchema>;
