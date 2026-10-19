import { z } from "zod";

/**
 * Public catalog entry — the gallery metadata for one template. Mirrors the `TemplateMeta` projection
 * (never the raw `TemplateDef`, which carries `composeFile`/`secrets`). Used only to DOCUMENT the
 * `GET /catalog` + `GET /catalog/:slug` responses in OpenAPI; the service already returns this exact,
 * secret-free shape.
 */
export const CatalogEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  icon: z.string().optional(),
  logo: z.string().optional(),
  documentation: z.string().optional(),
  // CASA-UX-3 presentation fields (optional, additive — older consumers ignore them).
  tagline: z.string().optional(),
  tags: z.array(z.string()).optional(),
  featured: z.boolean().optional(),
  badges: z.array(z.string()).optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
