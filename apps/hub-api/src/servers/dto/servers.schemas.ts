import { z } from "zod";

export const CreateServerSchema = z.object({
  name: z.string().min(1),
  teamId: z.string().min(1),
});
export type CreateServerInput = z.infer<typeof CreateServerSchema>;
