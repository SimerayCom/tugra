import { z } from "zod";

export const CreateDatabaseSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1),
  engine: z.enum(["POSTGRES", "MYSQL", "REDIS", "MONGO"]),
  version: z.string().min(1).optional(),
  hostPort: z.number().int().min(1).max(65535).optional(),
});
export type CreateDatabaseInput = z.infer<typeof CreateDatabaseSchema>;
