"use client";

import { useState } from "react";
import { launcherIcon } from "../lib/launcher";
import { TemplateLogo } from "../lib/template-icons";
import type { AppSource } from "../lib/types";

/**
 * The single source of truth for an app's icon: a user-uploaded custom icon when set (iconUrl), else the
 * catalog brand logo when the app was installed from a template, else its source icon (image/git/compose).
 */
export function AppLogo({
  iconUrl,
  templateSlug,
  templateLogo,
  source,
  name,
  size = 18,
  color = "var(--c-a)",
}: {
  iconUrl?: string | null;
  templateSlug: string | null;
  templateLogo: string | null;
  source: AppSource;
  name?: string;
  size?: number;
  color?: string;
}) {
  // Track the URL that failed to load (not a boolean) so a later upload — a new ?v= — is retried rather than
  // staying on the fallback. A 404 / transient error / undecodable icon falls through to the template/source
  // logo instead of the browser's broken-image glyph. The image is decorative: every call site shows the name.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (iconUrl && iconUrl !== failedUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconUrl}
        alt=""
        aria-hidden
        width={size}
        height={size}
        onError={() => setFailedUrl(iconUrl)}
        style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size / 6)), objectFit: "cover", display: "block" }}
      />
    );
  }
  if (templateSlug) {
    return <TemplateLogo logo={templateLogo ?? undefined} slug={templateSlug} name={name} size={size} />;
  }
  const Icon = launcherIcon(source);
  return <Icon size={size} color={color} />;
}
