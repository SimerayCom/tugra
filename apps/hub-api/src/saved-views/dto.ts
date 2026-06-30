import { z } from "zod";

export const CreateSavedViewSchema = z.object({
  name: z.string().min(1).max(40),
  status: z.enum(["ONLINE", "PENDING", "OFFLINE"]).nullable().optional(),
  tags: z.array(z.string()).optional(),
});
export type CreateSavedViewInput = z.infer<typeof CreateSavedViewSchema>;
