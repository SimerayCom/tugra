import { z } from "zod";

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "password must be at least 8 chars"),
  name: z.string().min(1).optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof RefreshSchema>;

export const Enable2faSchema = z.object({
  token: z.string().min(6),
});
export type Enable2faInput = z.infer<typeof Enable2faSchema>;
