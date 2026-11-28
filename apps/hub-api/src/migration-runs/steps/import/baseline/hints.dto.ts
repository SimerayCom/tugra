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
            /** `job-runner`: held until after the cutover (an app with no domain; one that serves a domain is refused by PREFLIGHT); `web`: starts dark even without one; `null` removes the mark. */
            role: z.enum(WORKER_MARKS).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type SetWorkerMarksInput = z.infer<typeof SetWorkerMarksSchema>;

/** A dry-run warning key: the code of the dry-run item, plus `:<risk>` for an import risk warning (`import.risk-warning:service.image.floating`). */
export const WARNING_ACK_KEY = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9.:_-]*$/, "invalid warning key");

/** `PUT /migration-runs/:id/warning-acks`: accept (or take back the acceptance of) warnings of a finished dry-run. */
export const SetWarningAcksSchema = z
  .object({
    acks: z.array(z.object({ key: WARNING_ACK_KEY, accepted: z.boolean() }).strict()).min(1).max(200),
  })
  .strict();
export type SetWarningAcksInput = z.infer<typeof SetWarningAcksSchema>;

/** The image ref a compose stack's floating member is pinned to: a version tag or a digest of its own repository (the hub checks the repository against the dry-run's own item). */
const SERVICE_PIN_REF = z
  .string()
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/, "invalid image reference");

/** `PUT /migration-runs/:id/service-pins`: pin (or, with `ref: null`, unpin) floating members of the compose stacks a finished dry run lists. */
export const SetServicePinsSchema = z
  .object({
    pins: z
      .array(
        z
          .object({
            /** The plan itemRef of the service (`service:<server>:<uuid>`). */
            itemRef: z.string().regex(/^service:[\x21-\x7e]{1,200}$/).max(340),
            /** The compose service key. */
            member: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/),
            ref: SERVICE_PIN_REF.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type SetServicePinsInput = z.infer<typeof SetServicePinsSchema>;

/**
 * `PUT /migration-runs/:id/exact-images`: tick (`keep: true`, the default) or untick "keep the exact image" for an app, a database or a
 * compose stack of the plan. An unticked item keeps what the source writes (its tag) instead of the image the source runs; ticking it
 * again brings the recorded image back. Closed once the run passed the point of no return, like every hint.
 */
export const SetExactImagesSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            /** The plan itemRef of the app, database or service. */
            itemRef: z.string().regex(/^(app|database|service):[\x21-\x7e]{1,280}$/).max(340),
            keep: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type SetExactImagesInput = z.infer<typeof SetExactImagesSchema>;

export const SafetyHintsSchema = z.object({
  imagePins: z.array(z.object({ image: z.string(), scope: z.string(), digest: z.string(), evidence: z.string() })),
  workerMarks: z.array(z.object({ itemRef: z.string(), role: z.enum(WORKER_MARKS) })),
  /** The dry-run warning keys the operator accepted. */
  warningAcks: z.array(z.string()),
  /** The pins of compose-stack members recorded on a dry run (a promoted run carries them into its stack choices). */
  servicePins: z.array(z.object({ itemRef: z.string(), member: z.string(), ref: z.string(), evidence: z.string() })),
  /**
   * The exact image the source runs for every app, database and stack member the host reported on (`ref` is `repo:tag@sha256:...`, or
   * `repo:<version>`), with the image's own version label and digest when known. `kept: false` = the owner unticked "keep the exact image".
   * `member` is empty for an app or a database.
   */
  exactImages: z.array(z.object({ itemRef: z.string(), member: z.string(), ref: z.string(), tag: z.string(), version: z.string().nullable(), digest: z.string().nullable(), kept: z.boolean() })),
  /**
   * The apps, databases and stack members the host's inventory covered but reported no exact image for (a locally built image, an older
   * script, two different digests): they keep the image the source writes, and the screen says "unknown". Empty until an inventory arrived.
   * `image` is what the plan writes for it ("" for a database the plan names no image for).
   */
  exactUnknown: z.array(z.object({ itemRef: z.string(), member: z.string(), image: z.string() })),
  /** The warning keys of a finished dry run that are settled by a fix (every floating image behind them is pinned); empty for any other run. */
  warningsFixed: z.array(z.string()),
});
export type SafetyHints = z.infer<typeof SafetyHintsSchema>;
