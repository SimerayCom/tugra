"use client";

import { Link2 } from "lucide-react";
import { Menu, type MenuItem } from "../../../../components/menu";
import { useT } from "../../../../i18n/provider";
import { linkLabel } from "../../../../lib/app-links";
import type { AppLink } from "../../../../lib/types";

/** Plain-language description of a link (its kind, plus the compose service / port it belongs to). */
export function linkKindText(t: ReturnType<typeof useT>, link: AppLink): string {
  switch (link.kind) {
    case "alias": return t("apps.linksKindAlias");
    case "service": return t("apps.linksKindService", { service: link.label ?? "" });
    case "port": return t("apps.linksKindPort", { label: link.label ?? "" });
    default: return t("apps.linksKindPrimary");
  }
}

/**
 * Header "Links (n)" menu: every externally-openable address of the app (primary, alias domains, per-service
 * domains, published compose ports), each opening in a new tab. Shown to every viewer. Renders nothing for fewer
 * than two links — the header's own primary anchor already covers a single address.
 */
export function AppLinksMenu({ links }: { links: AppLink[] }) {
  const t = useT();
  if (links.length < 2) return null;
  const items: MenuItem[] = links.map((l, i) => ({
    key: `${l.kind}-${i}`,
    label: linkLabel(l),
    href: l.url,
    title: `${linkKindText(t, l)} — ${t("apps.linksOpenNewTab")}`,
  }));
  return <Menu items={items} label={t("apps.linksMenu", { n: links.length })} align="start" trigger={{ icon: Link2, label: t("apps.linksMenu", { n: links.length }) }} />;
}
