import { appFaviconUrl, appIconUrl } from "./api";
import type { AppSource } from "./types";

/** The fields of an app, tile or project resource that decide its icon. */
export interface AppIconSource {
  id: string;
  name: string;
  iconUpdatedAt: string | null;
  iconKey?: string | null;
  image?: string | null;
  /** The app's own domain; a non-empty value enables the site favicon. */
  domain?: string | null;
  templateSlug: string | null;
  templateLogo: string | null;
  source: AppSource;
}

/** Props for <AppLogo/> from one app-like record, so every list builds the same icon. */
export function appLogoProps(a: AppIconSource) {
  return {
    iconUrl: appIconUrl(a.id, a.iconUpdatedAt),
    iconKey: a.iconKey ?? null,
    faviconUrl: appFaviconUrl(a.id, a.domain),
    image: a.image ?? null,
    templateSlug: a.templateSlug,
    templateLogo: a.templateLogo,
    source: a.source,
    name: a.name,
  };
}
