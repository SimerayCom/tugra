"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Branding } from "../lib/types";

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

/** The logo + product name, themed. Falls back to the Tugra seal + "Tugra". */
export function BrandMark({ size = 36, nameSize = 19, showName = true }: { size?: number; nameSize?: number; showName?: boolean }) {
  const b = useBranding();
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={b.logoUrl || "/tugra-logo.svg"} alt={b.name || "Tugra"} width={size} height={size} style={{ objectFit: "contain" }} />
      {showName && <div style={{ fontWeight: 700, fontSize: nameSize, letterSpacing: "-0.01em" }}>{b.name || "Tugra"}</div>}
    </>
  );
}

/** A subtle "Powered by Tugra" attribution. Hidden when a Pro instance opts out (hidePoweredBy). */
export function PoweredBy({ style }: { style?: React.CSSProperties }) {
  const b = useBranding();
  if (b.hidePoweredBy) return null;
  return (
    <div style={{ textAlign: "center", fontSize: 11, color: "var(--c-tx3)", marginTop: 18, ...style }}>
      Powered by{" "}
      <a href="https://github.com/SimerayCom/tugra" target="_blank" rel="noreferrer" style={{ color: "var(--c-tx3)" }}>
        Tugra
      </a>
    </div>
  );
}
