"use client";

import { launcherIcon } from "../lib/launcher";
import { ResourceIcon } from "./resource-icon";
import type { AppSource } from "../lib/types";

/**
 * The single source of truth for an app's icon: an uploaded icon, the icon the user picked, the site's favicon
 * (when the app has a domain), the brand of its image, the catalog brand when installed from a template, else
 * its source icon (image/git/compose).
 */
export function AppLogo({
  iconUrl,
  iconKey,
  faviconUrl,
  image,
  templateSlug,
  templateLogo,
  source,
  name,
  size = 18,
  color = "var(--c-a)",
}: {
  iconUrl?: string | null;
  iconKey?: string | null;
  faviconUrl?: string | null;
  image?: string | null;
  templateSlug: string | null;
  templateLogo: string | null;
  source: AppSource;
  name?: string;
  size?: number;
  color?: string;
}) {
  const Icon = launcherIcon(source);
  return (
    <ResourceIcon
      iconUrl={iconUrl}
      iconKey={iconKey}
      faviconUrl={faviconUrl}
      // A built-from-git app has no meaningful image reference; only a plain image app is matched by its image.
      image={source === "IMAGE" ? image : null}
      brand={templateSlug ? { logo: templateLogo ?? undefined, slug: templateSlug } : null}
      name={name}
      size={size}
      fallback={<Icon size={size} color={color} />}
    />
  );
}
