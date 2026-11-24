import { z } from "zod";
import { CONTAINER_REF_RE } from "../../migrator/discover-script";

/** Where the Uptime Kuma data comes from. */
export const KumaSourceSchema = z.discriminatedUnion("kind", [
  // The text of the JSON backup downloaded from Kuma (Settings > Backup).
  z.object({ kind: z.literal("backup"), json: z.string().min(2).max(4_000_000) }),
  // Read kuma.db from the Kuma container's data volume on a server this team owns.
  z.object({
    kind: z.literal("server"),
    serverId: z.string().min(1),
    container: z.string().regex(CONTAINER_REF_RE, "invalid container name").optional(),
  }),
]);
export type KumaSource = z.infer<typeof KumaSourceSchema>;

export const KumaPreviewSchema = z.object({ teamId: z.string().min(1), source: KumaSourceSchema });
export type KumaPreviewInput = z.infer<typeof KumaPreviewSchema>;

export const KumaApplySchema = KumaPreviewSchema.extend({
  /** Kuma monitor ids to import. Omit for every importable one. */
  monitorRefs: z.array(z.string().min(1)).max(2000).optional(),
  /** Kuma notification ids the user confirmed creating as Tugra channels. Channels not listed are not created, and
   *  the monitors that used them are imported without that link. */
  createChannelRefs: z.array(z.string().min(1)).max(500).optional(),
});
export type KumaApplyInput = z.infer<typeof KumaApplySchema>;

export const KumaDetectSchema = z.object({ teamId: z.string().min(1), serverId: z.string().min(1) });
export type KumaDetectInput = z.infer<typeof KumaDetectSchema>;
