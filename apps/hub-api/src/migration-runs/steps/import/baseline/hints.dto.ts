import { z } from "zod";
import { DIGEST_RE } from "./image-pins";
import { WORKER_MARKS } from "./workers";

/** `PUT /migration-runs/:id/image-pins` and `PUT .../worker-marks` bodies, and the shape `GET .../safety-hints` answers. */

const IMAGE_KEY = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\/:-]*$/, "invalid image reference");
const SCOPE = z
  .string()
  .max(200)
  .regex(/^[\x21-\x7e]*$/, "invalid source server ref");
/** Who vouches for the digest: the operator who typed it, or the host-loop script's output the operator carried back. */
const PIN_EVIDENCE = z.enum(["operator-attested", "host-loop-reported"]);

export const SetImagePinsSchema = z
  .object({
    pins: z
      .array(
        z
          .object({
            /** The image ref as the plan shows it (`getmeili/meilisearch:latest`). */
            image: IMAGE_KEY,
            /** The source server (Coolify server uuid) that runs this digest; omitted = every server. */
            scope: SCOPE.default(""),
            /** `sha256:<64 hex>` the SOURCE runs; `null` removes the pin. */
            digest: z.string().regex(DIGEST_RE, "digest must be sha256:<64 lower-case hex>").nullable(),
            evidence: PIN_EVIDENCE.default("operator-attested"),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type SetImagePinsInput = z.infer<typeof SetImagePinsSchema>;

export const SetWorkerMarksSchema = z
  .object({
    marks: z
      .array(
        z
          .object({
            /** The plan itemRef of the app (`app:<server>:<ref>`). */
            itemRef: z.string().min(1).max(340),
            /** `job-runner`: held until after the cutover even with a domain; `web`: starts dark even without one; `null` removes the mark. */
            role: z.enum(WORKER_MARKS).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type SetWorkerMarksInput = z.infer<typeof SetWorkerMarksSchema>;

export const SafetyHintsSchema = z.object({
  imagePins: z.array(z.object({ image: z.string(), scope: z.string(), digest: z.string(), evidence: z.string() })),
  workerMarks: z.array(z.object({ itemRef: z.string(), role: z.enum(WORKER_MARKS) })),
});
export type SafetyHints = z.infer<typeof SafetyHintsSchema>;
