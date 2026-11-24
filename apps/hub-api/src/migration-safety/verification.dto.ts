import { z } from "zod";
import { PROBE_PATH_RE } from "../cutover/cutover.logic";

/** Extra pages to compare besides `/` and the run's health path. */
export const RunVerificationSchema = z
  .object({
    paths: z.array(z.string().regex(PROBE_PATH_RE)).max(8).default([]),
  })
  .strict();
export type RunVerificationInput = z.infer<typeof RunVerificationSchema>;
