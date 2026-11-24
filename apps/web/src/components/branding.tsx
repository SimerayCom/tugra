"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Branding } from "../lib/types";
import { SITE_URL } from "../lib/help-links";

const DEFAULTS: Branding = { name: null, logoUrl: null, faviconUrl: null, accentColor: null, hidePoweredBy: false };

const BrandingCtx = createContext<Branding>(DEFAULTS);

/** The effective white-label branding (Tugra defaults until a Pro instance sets its own). */
export function useBranding(): Branding {
  return useContext(BrandingCtx);
}

/**
 * Fetches the public branding once and applies the app-wide bits as side effects: the accent token
 * (--c-a, inline on <html> so it wins over both themes), the document title and the favicon. The
 * per-component bits (logo, name, footer) are read from context by <BrandMark> / <PoweredBy>. Wraps the
 * WHOLE app (login included) so an unauthenticated visitor sees the customer's brand, not Tugra.
 */
export function BrandingProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({ queryKey: ["branding"], queryFn: () => api.getBranding(), staleTime: 300_000, retry: false });
  const b = data ?? DEFAULTS;

  useEffect(() => {
    const root = document.documentElement;
    if (b.accentColor) root.style.setProperty("--c-a", b.accentColor);
    else root.style.removeProperty("--c-a");
  }, [b.accentColor]);

  useEffect(() => {
    if (b.name) document.title = b.name;
  }, [b.name]);

  useEffect(() => {
    if (!b.faviconUrl) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    const prev = link.href;
    link.href = b.faviconUrl;
    return () => {
      link!.href = prev;
    };
  }, [b.faviconUrl]);

  return <BrandingCtx.Provider value={b}>{children}</BrandingCtx.Provider>;
}

/**
 * The logo + product name, themed. Falls back to the Tugra seal + "Tugra". With `href` the mark is a link
 * (the sidebar logo goes home); with `version` the running version sits under the name, or in the link's
 * title when the name is hidden (collapsed sidebar), so it is always one glance away.
 */
export function BrandMark({ size = 36, nameSize = 19, showName = true, href, version, linkLabel }: { size?: number; nameSize?: number; showName?: boolean; href?: string; version?: string | null; linkLabel?: string }) {
  const b = useBranding();
  const name = b.name || "Tugra";
  const ver = version ? `v${version.replace(/^v/, "")}` : null;
  const mark = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={b.logoUrl || "/tugra-logo.svg"} alt={name} width={size} height={size} style={{ objectFit: "contain", flexShrink: 0 }} />
      {showName && (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: nameSize, letterSpacing: "-0.01em", lineHeight: 1.1 }}>{name}</div>
          {ver && <div className="mono" data-testid="brand-version" style={{ fontSize: 10.5, color: "var(--c-tx3)", marginTop: 2, whiteSpace: "nowrap" }}>{ver}</div>}
        </div>
      )}
    </>
  );
  if (!href) return mark;
  const title = ver ? `${name} ${ver}` : name;
  return (
    <Link href={href} aria-label={linkLabel || name} title={title} data-testid="brand-link" style={{ display: "flex", alignItems: "center", gap: 9, color: "inherit", textDecoration: "none", minWidth: 0 }}>
      {mark}
    </Link>
  );
}

/** A subtle "Powered by Tugra" attribution. Hidden when a Pro instance opts out (hidePoweredBy). */
export function PoweredBy({ style }: { style?: React.CSSProperties }) {
  const b = useBranding();
  if (b.hidePoweredBy) return null;
  return (
    <div style={{ textAlign: "center", fontSize: 11, color: "var(--c-tx3)", marginTop: 18, ...style }}>
      Powered by{" "}
      <a href={SITE_URL} target="_blank" rel="noreferrer" style={{ color: "var(--c-tx3)" }}>
        Tugra
      </a>
    </div>
  );
}
