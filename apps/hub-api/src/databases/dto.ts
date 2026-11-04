import { z } from "zod";
import { isValidUserEnvKey, isSafeEnvValue } from "../common/env-key";

// User-set container env for a database. Same ingress guard as app env (closes the `--env-file`
// line-injection boundary) built on the shared env-key primitives, so DB and app env validate identically.
// Reserved engine keys (POSTGRES_PASSWORD, …) are rejected in the service, where the engine is known.
export const SetDatabaseEnvSchema = z.object({
  env: z
    .record(z.string())
    .refine((env) => Object.keys(env).every(isValidUserEnvKey), { message: "invalid environment variable name" })
    .refine((env) => Object.values(env).every(isSafeEnvValue), { message: "environment value must not contain a newline" }),
});
export type SetDatabaseEnvInput = z.infer<typeof SetDatabaseEnvSchema>;

export const CreateDatabaseSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1),
  engine: z.enum(["POSTGRES", "MYSQL", "REDIS", "MONGO", "MARIADB", "KEYDB", "DRAGONFLY", "CLICKHOUSE", "LIBSQL"]),
  version: z.string().min(1).optional(),
  hostPort: z.number().int().min(1).max(65535).optional(),
  environmentId: z.string().min(1).optional(),
});
export type CreateDatabaseInput = z.infer<typeof CreateDatabaseSchema>;

export const SetEnvironmentSchema = z.object({
  environmentId: z.string().min(1), // required: every database belongs to an environment
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

export const RenameSchema = z.object({
  name: z.string().min(1).max(100),
});
export type RenameInput = z.infer<typeof RenameSchema>;

// Clone a database's config (never its data) to a new, un-provisioned DB on the same server. Optional new
// name (else "<src> (copy)") and target environment (else the source's).
export const CloneDatabaseSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  environmentId: z.string().min(1).optional(),
});
export type CloneDatabaseInput = z.infer<typeof CloneDatabaseSchema>;

// A base64-encoded PNG icon (≈ 4/3 of the 64KB byte cap). Structure/size are validated server-side.
export const SetIconSchema = z.object({
  data: z.string().min(1).max(96_000),
});
export type SetIconInput = z.infer<typeof SetIconSchema>;
