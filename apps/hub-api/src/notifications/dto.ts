import { z } from "zod";

export const EVENT_TYPES = [
  "deploy_success",
  "deploy_failed",
  "server_offline",
  "monitor_down",
  "monitor_up",
] as const;

export const CreateChannelSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  teamId: z.string().min(1),
  config: z.record(z.unknown()),
  eventTypes: z.array(z.enum(EVENT_TYPES)).optional(),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const UpdateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  eventTypes: z.array(z.enum(EVENT_TYPES)).optional(),
  config: z.record(z.unknown()).optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelSchema>;
