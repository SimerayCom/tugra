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

export const UpdateProfileSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    email: z.string().email().optional(),
  })
  .refine((v) => v.name !== undefined || v.email !== undefined, "nothing to update");
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "password must be at least 8 chars"),
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
