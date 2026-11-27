"use client";

import { useState, type ReactNode } from "react";
import { iconKeyForImage, isResourceIconKey } from "@tugra/shared/dist/resource-icons";
import { TemplateLogo } from "../lib/template-icons";

/**
 * One icon for any resource row (app, database, service, container). The first source that applies wins:
 * an uploaded icon, the icon the user picked, the site's favicon (apps with a domain), the brand of the
 * image it runs, the catalog/engine brand, then `fallback`. Image sources that fail to load (404, a broken file)
 * fall through to the next one. Fixed width and height and lazy loading, so a list never shifts while icons arrive.
 */
export function ResourceIcon({
  iconUrl,
  iconKey,
  faviconUrl,
  image,
  brand,
  name,
  size = 20,
  fallback,
}: {
  /** Same-origin URL of an uploaded icon. */
  iconUrl?: string | null;
  /** Key picked from the shared icon set. */
  iconKey?: string | null;
  /** Same-origin URL of the site's favicon (served by the hub). */
  faviconUrl?: string | null;
  /** Container image reference; its brand is used when it names a known one. */
  image?: string | null;
  /** Catalog or engine logo, used when the image says nothing. */
  brand?: { logo?: string; slug: string } | null;
  name?: string;
  size?: number;
  fallback: ReactNode;
}) {
  // Track the URLs that failed (not a boolean) so a later upload, a new ?v=, is tried again.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const img = (src: string, radius: number) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={src}
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed((p) => new Set(p).add(src))}
      style={{ width: size, height: size, borderRadius: radius, objectFit: "cover", display: "block", flexShrink: 0 }}
    />
  );
  const radius = Math.max(3, Math.round(size / 6));
  if (iconUrl && !failed.has(iconUrl)) return img(iconUrl, radius);
  if (isResourceIconKey(iconKey)) return <TemplateLogo key={iconKey} slug={iconKey} name={name} size={size} />;
  if (faviconUrl && !failed.has(faviconUrl)) return img(faviconUrl, radius);
  const byImage = iconKeyForImage(image);
  if (byImage) return <TemplateLogo key={byImage} slug={byImage} name={name} size={size} />;
  if (brand) return <TemplateLogo logo={brand.logo} slug={brand.slug} name={name} size={size} />;
  return <>{fallback}</>;
}
