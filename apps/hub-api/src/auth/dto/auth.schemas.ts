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
  // Optional: browser sessions carry the refresh token in the httpOnly `tg_refresh` cookie instead
  // of the body. Body clients (PAT/CLI/e2e) still send it here. The controller reads cookie-or-body.
  refreshToken: z.string().min(1).optional(),
});
export type RefreshInput = z.infer<typeof RefreshSchema>;

export const Enable2faSchema = z.object({
  token: z.string().min(6),
});
export type Enable2faInput = z.infer<typeof Enable2faSchema>;

// Sudo re-auth for sensitive 2FA mutations: current password + a 2FA code (TOTP 6-digit or a
// recovery code like XXXX-XXXX). min(6) admits both.
export const TwoFaSudoSchema = z.object({
  password: z.string().min(1),
  code: z.string().min(6),
});
export type TwoFaSudoInput = z.infer<typeof TwoFaSudoSchema>;

export const UpdateProfileSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    email: z.string().email().optional(),
    uiMode: z.enum(["fleet", "home"]).optional(),
    // Required only when changing the email — sudo re-auth so a stolen session can't swap the address.
    currentPassword: z.string().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.email !== undefined || v.uiMode !== undefined,
    "nothing to update",
  );
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "password must be at least 8 chars"),
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

export const ForgotPasswordSchema = z.object({ email: z.string().email() });
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, "password must be at least 8 chars"),
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export const VerifyEmailSchema = z.object({
  token: z.string().min(1),
});
export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;
