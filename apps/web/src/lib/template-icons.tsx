import {
  SiAdminer,
  SiGhost,
  SiN8n,
  SiUptimekuma,
  SiWordpress,
} from "@icons-pack/react-simple-icons";
import { Boxes } from "lucide-react";
import type { ComponentType } from "react";

type IconCmp = ComponentType<{ size?: number; color?: string; title?: string }>;

/** Real brand SVGs for the one-click templates (replaces the old emoji icons). */
const TEMPLATE_ICONS: Record<string, IconCmp> = {
  wordpress: SiWordpress,
  ghost: SiGhost,
  n8n: SiN8n,
  "uptime-kuma": SiUptimekuma,
  adminer: SiAdminer,
};

/** Resolve a template slug to its brand icon, falling back to a generic glyph. */
export function templateIcon(slug: string): IconCmp {
  return TEMPLATE_ICONS[slug] ?? Boxes;
}
