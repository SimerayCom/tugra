import { z } from "zod";
import { isSafeEnvValue } from "../common/env-key";

export const SetSharedVarSchema = z.object({
  teamId: z.string().min(1),
  key: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "key must be a valid env var name"),
  // Shared variables stay single-line (and are not flaggable): a line break would define an extra variable in the env file.
  value: z.string().refine(isSafeEnvValue, { message: "environment value must not contain a newline" }),
});
export type SetSharedVarInput = z.infer<typeof SetSharedVarSchema>;
