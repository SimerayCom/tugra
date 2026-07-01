import { z } from "zod";

export const CreateSavedViewSchema = z.object({
  name: z.string().min(1).max(40),
  status: z.enum(["ONLINE", "PENDING", "OFFLINE"]).nullable().optional(),
  tags: z.array(z.string()).optional(),
  // Set to share the view with a team; omit for a personal view.
  teamId: z.string().min(1).optional(),
});
export type CreateSavedViewInput = z.infer<typeof CreateSavedViewSchema>;
