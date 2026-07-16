import { z } from "zod";
import { SCOPES } from "./scopes";

export const CreateApiTokenSchema = z.object({
  name: z.string().min(1).max(100),
  // Least-privilege by default: an unspecified token is read-only (so existing/CLI callers that omit
  // scopes keep working, just read-only). The UI presents the full picker.
  scopes: z.array(z.enum(SCOPES)).nonempty().default(["read"]),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateApiTokenInput = z.infer<typeof CreateApiTokenSchema>;
