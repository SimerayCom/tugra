"use client";

import { launcherIcon } from "../lib/launcher";
import { TemplateLogo } from "../lib/template-icons";
import type { AppSource } from "../lib/types";

/**
 * The single source of truth for an app's icon: the catalog brand logo when the
 * app was installed from a template, otherwise its source icon (image/git/compose).
 */
export function AppLogo({
  templateSlug,
  templateLogo,
  source,
  name,
  size = 18,
  color = "var(--c-a)",
}: {
  templateSlug: string | null;
  templateLogo: string | null;
  source: AppSource;
  name?: string;
  size?: number;
  color?: string;
}) {
  if (templateSlug) {
    return <TemplateLogo logo={templateLogo ?? undefined} slug={templateSlug} name={name} size={size} />;
  }
  const Icon = launcherIcon(source);
  return <Icon size={size} color={color} />;
}
