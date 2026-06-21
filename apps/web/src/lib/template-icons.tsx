import {
  SiAdminer,
  SiDirectus,
  SiExcalidraw,
  SiGhost,
  SiGitea,
  SiGrafana,
  SiJellyfin,
  SiMatomo,
  SiMealie,
  SiMetabase,
  SiMinio,
  SiN8n,
  SiNextcloud,
  SiNodered,
  SiPocketbase,
  SiUmami,
  SiUptimekuma,
  SiVaultwarden,
  SiWikidotjs,
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
  pocketbase: SiPocketbase,
  gitea: SiGitea,
  directus: SiDirectus,
  umami: SiUmami,
  metabase: SiMetabase,
  matomo: SiMatomo,
  grafana: SiGrafana,
  vaultwarden: SiVaultwarden,
  minio: SiMinio,
  nextcloud: SiNextcloud,
  jellyfin: SiJellyfin,
  excalidraw: SiExcalidraw,
  mealie: SiMealie,
  wikijs: SiWikidotjs,
  "node-red": SiNodered,
};

/** Resolve a template slug to its brand icon, falling back to a generic glyph. */
export function templateIcon(slug: string): IconCmp {
  return TEMPLATE_ICONS[slug] ?? Boxes;
}
