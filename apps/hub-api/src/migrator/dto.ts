import { z } from "zod";
import { CONTAINER_REF_RE } from "./discover-script";

/** Adopt a single foreign container as a Tugra app. The client only chooses WHICH container (by its
 *  docker name/id), the app name, and which port/env to import — never raw image/port/env values
 *  (those are re-read fresh from the server). `container` is regex-validated (shell-injection guard). */
export const AdoptSchema = z.object({
  container: z.string().min(1).max(128).regex(CONTAINER_REF_RE, "invalid container reference"),
  name: z.string().min(1).max(100),
  environmentId: z.string().min(1).optional(),
  portIndex: z.number().int().min(0).optional(), // index into discover()'s ports[]; default 0
  envKeys: z.array(z.string().min(1).max(256)).max(500).optional(), // subset to import; omitted = all (minus noise)
});
export type AdoptInput = z.infer<typeof AdoptSchema>;
