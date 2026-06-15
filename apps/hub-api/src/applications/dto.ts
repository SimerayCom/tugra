import { z } from "zod";

export const CreateAppSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1),
  image: z.string().min(1),
  env: z.record(z.string()).optional(),
  hostPort: z.number().int().min(1).max(65535).optional(),
  containerPort: z.number().int().min(1).max(65535).optional(),
});
export type CreateAppInput = z.infer<typeof CreateAppSchema>;
