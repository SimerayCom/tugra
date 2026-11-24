"use client";

import type { CSSProperties, ReactNode } from "react";
import { useT } from "../i18n/provider";
import { guideUrl, type GuideId } from "../lib/help-links";

/**
 * The "?" at the top right of a screen: opens that screen's step-by-step guide on tugra.io/docs in a new tab. A real link
 * (keyboard, middle-click and screen readers work), labelled with the guide's name, and a 44px target on touch screens.
 */
export function HelpLink({ guide, style }: { guide: GuideId; style?: CSSProperties }) {
  const t = useT();
  const label = t(`common.help.guide.${guide}`);
  return (
    <a
      href={guideUrl(guide)}
      target="_blank"
      rel="noopener noreferrer"
      className="tg-help"
      data-testid={`help-guide-${guide}`}
      aria-label={label}
      title={label}
      style={style}
    >
      <span aria-hidden>?</span>
    </a>
  );
}

/**
 * A closed "More" disclosure for the detail a field does not need at first sight. Native <details>: keyboard and screen-reader
 * friendly with no script. The caller keeps the one-line hint outside it.
 */
export function MoreInfo({ children, label, style }: { children: ReactNode; label?: string; style?: CSSProperties }) {
  const t = useT();
  return (
    <details className="tg-more" style={style}>
      <summary>{label ?? t("common.more")}</summary>
      <div className="tg-more-body">{children}</div>
    </details>
  );
}
