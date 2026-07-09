import { z } from "zod";

// Registry host (blank → Docker Hub) and image namespace flow into the deploy script's
// `docker login`/`docker tag`/`docker push` — constrain to safe registry characters (no
// whitespace/scheme/shell metacharacters) as defence-in-depth alongside shell escaping.
const hostRe = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$/;
const prefixRe = /^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

export const CreateRegistrySchema = z.object({
  name: z.string().min(1),
  teamId: z.string().min(1),
  type: z.enum(["dockerhub", "ghcr", "gitlab", "generic"]),
  url: z.string().regex(hostRe, "invalid registry host").nullable().optional(),
  username: z.string().min(1),
  password: z.string().min(1),
  imagePrefix: z.string().regex(prefixRe, "invalid image prefix").max(200).nullable().optional(),
});
export type CreateRegistryInput = z.infer<typeof CreateRegistrySchema>;

export const UpdateRegistrySchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(["dockerhub", "ghcr", "gitlab", "generic"]).optional(),
  url: z.string().regex(hostRe, "invalid registry host").nullable().optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(), // only re-encrypted when supplied
  imagePrefix: z.string().regex(prefixRe, "invalid image prefix").max(200).nullable().optional(),
});
export type UpdateRegistryInput = z.infer<typeof UpdateRegistrySchema>;
