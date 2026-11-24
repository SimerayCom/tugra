import { z } from "zod";

/** A "#rrggbb" accent colour, normalised to lower case. Anything else (3-digit, named, rgba) is rejected. */
export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #rrggbb hex value")
  .transform((v) => v.toLowerCase());

/** Body of the colour endpoints: a hex colour, or null to clear back to the default accent. */
export const SetColorSchema = z.object({ color: HexColorSchema.nullable() });
export type SetColorInput = z.infer<typeof SetColorSchema>;
