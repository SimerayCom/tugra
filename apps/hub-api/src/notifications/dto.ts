import { z } from "zod";

export const CreateChannelSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  teamId: z.string().min(1),
  config: z.record(z.unknown()),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;
