import { iconKeyForImage } from "@tugra/shared/dist/resource-icons";
import { ENGINE_LOGO } from "./template-icons";
import type { ImportPlanItem } from "./types";

/** What <ResourceIcon/> needs for an import row: the image whose brand to show, and the engine brand as a fallback. */
export interface ImportIconInput {
  image: string | null;
  brand: { logo?: string; slug: string } | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Icon inputs for one app or database row of the import plan (read from the plan, nothing is fetched). */
export function importItemIcon(item: ImportPlanItem): ImportIconInput {
  const image = str(item.proposed.image);
  const engine = str(item.proposed.engine);
  const logo = item.kind === "database" && engine ? ENGINE_LOGO[engine] : undefined;
  return { image, brand: logo && engine ? { logo, slug: engine } : null };
}

/** Icon input for a service stack: the stack's own name first ("n8n"), then the first member that names a known brand. */
export function importServiceIcon(name: string, members: ReadonlyArray<{ name: string }>): ImportIconInput {
  const hit = [name, ...members.map((m) => m.name)].find((n) => iconKeyForImage(n) !== null);
  return { image: hit ?? null, brand: null };
}
