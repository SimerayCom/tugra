import { z } from "zod";

export const CreateDatabaseSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1),
  engine: z.enum(["POSTGRES", "MYSQL", "REDIS", "MONGO", "MARIADB", "KEYDB", "DRAGONFLY", "CLICKHOUSE"]),
  version: z.string().min(1).optional(),
  hostPort: z.number().int().min(1).max(65535).optional(),
  environmentId: z.string().min(1).optional(),
});
export type CreateDatabaseInput = z.infer<typeof CreateDatabaseSchema>;

export const SetEnvironmentSchema = z.object({
  environmentId: z.string().min(1).nullable(),
});
export type SetEnvironmentInput = z.infer<typeof SetEnvironmentSchema>;

export const SetDatabaseLimitsSchema = z.object({
  healthCmd: z.string().min(1).nullable().optional(),
  memoryMb: z.number().int().min(16).max(1024 * 1024).nullable().optional(),
  cpus: z.number().min(0.1).max(64).nullable().optional(),
});
export type SetDatabaseLimitsInput = z.infer<typeof SetDatabaseLimitsSchema>;

export const SetDatabasePortSchema = z.object({
  hostPort: z.number().int().min(1).max(65535).nullable(),
});
export type SetDatabasePortInput = z.infer<typeof SetDatabasePortSchema>;
