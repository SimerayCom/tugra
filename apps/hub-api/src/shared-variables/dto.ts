import { z } from "zod";

export const SetSharedVarSchema = z.object({
  teamId: z.string().min(1),
  key: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "key must be a valid env var name"),
  value: z.string(),
});
export type SetSharedVarInput = z.infer<typeof SetSharedVarSchema>;
