import { z } from "zod";

const oneLine = /^[^\r\n]+$/;

const slug = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and dashes only");

export const UpdateStatusPageSchema = z.object({
  slug,
  title: z.string().trim().min(1).max(80).regex(oneLine),
  description: z.string().trim().max(500).nullable().optional(),
  enabled: z.boolean(),
  monitors: z
    .array(z.object({ monitorId: z.string().min(1), label: z.string().trim().min(1).max(80).regex(oneLine).nullable().optional() }))
    .max(50)
    .refine((l) => new Set(l.map((m) => m.monitorId)).size === l.length, "a monitor can only be listed once"),
});
export type UpdateStatusPageInput = z.infer<typeof UpdateStatusPageSchema>;

export const CreateMaintenanceSchema = z
  .object({
    title: z.string().trim().min(1).max(120).regex(oneLine),
    body: z.string().trim().max(1000).nullable().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), "the window must end after it starts");
export type CreateMaintenanceInput = z.infer<typeof CreateMaintenanceSchema>;

export const SubscribeSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
export type SubscribeInput = z.infer<typeof SubscribeSchema>;

export const SubscriberTokenSchema = z.object({ token: z.string().min(10).max(200) });
export type SubscriberTokenInput = z.infer<typeof SubscriberTokenSchema>;
