"use client";

import { useState } from "react";
import { Box } from "lucide-react";
import { useT } from "../i18n/provider";
import { planAppIcon, planIconUrl } from "../lib/plan-app-icon";
import type { ImportPlanItem } from "../lib/types";
import { ResourceIcon } from "./resource-icon";

/** How many apps a server card lists before "Show all". */
export const PLAN_APP_ROWS_SHOWN = 5;

/**
 * The apps of one server as they are in the plan: an icon (a GitHub avatar for an app built from a GitHub repository, else its site's favicon, else
 * the brand of its image or catalog entry, else a plain box), the name, and its domain in monospace. The icons come through the hub; none of this
 * reads anything secret. Folded to the first few with a "Show all N" button.
 */
export function PlanAppRows({ apps }: { apps: ReadonlyArray<Pick<ImportPlanItem, "itemRef" | "name" | "proposed">> }) {
  const t = useT();
  const [all, setAll] = useState(false);
  if (apps.length === 0) return null;
  const shown = all ? apps : apps.slice(0, PLAN_APP_ROWS_SHOWN);
  return (
    <div data-testid="plan-app-rows" style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
        {shown.map((a) => {
          const i = planAppIcon(a);
          return (
            <li key={a.itemRef} data-testid="plan-app-row" style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 36, minWidth: 0 }}>
              <ResourceIcon
                size={20}
                name={a.name}
                iconUrl={i.githubOwner ? planIconUrl("github", i.githubOwner) : null}
                faviconUrl={i.domain ? planIconUrl("site", i.domain) : null}
                image={i.image}
                brand={i.templateSlug ? { slug: i.templateSlug } : null}
                fallback={<Box size={20} color="var(--c-tx3)" aria-hidden />}
              />
              <span style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere", minWidth: 0 }}>{a.name}</span>
              {i.domain && <span className="mono" style={{ fontSize: 12, color: "var(--c-tx3)", overflowWrap: "anywhere", minWidth: 0 }}>{i.domain}</span>}
            </li>
          );
        })}
      </ul>
      {apps.length > PLAN_APP_ROWS_SHOWN && (
        <button type="button" onClick={() => setAll(!all)} className="tg-link" style={{ alignSelf: "flex-start", minHeight: 44, padding: 0, background: "none", border: "none", cursor: "pointer", fontSize: 12.5 }}>
          {all ? t("placement.campaign.apps.fewer") : t("placement.campaign.apps.showAll", { count: apps.length })}
        </button>
      )}
    </div>
  );
}
