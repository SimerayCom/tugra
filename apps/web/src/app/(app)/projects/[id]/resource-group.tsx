"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { AppLogo } from "../../../../components/app-logo";
import { ResourceIcon } from "../../../../components/resource-icon";
import { StatusPill } from "../../../../components/ui";
import { TagChips } from "../../../../components/tags";
import { databaseIconUrl } from "../../../../lib/api";
import { appLogoProps } from "../../../../lib/app-icon";
import { appColor } from "../../../../lib/apps";
import { dbColor } from "../../../../lib/databases";
import { ENGINE_LOGO } from "../../../../lib/template-icons";
import type { AppSource, AppStatus, DbStatus, ProjectResource } from "../../../../lib/types";

/** One group of a project's resources (apps, services or databases), one icon + status row each. */
export function ResourceGroup({ title, items, icon: Icon }: { title: string; items: ProjectResource[]; icon: LucideIcon }) {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "4px 0 6px" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 8 }}>
        {items.map((r) => {
          const color = r.kind === "app" ? appColor(r.status as AppStatus) : dbColor(r.status as DbStatus);
          return (
            <Link
              key={`${r.kind}:${r.id}`}
              href={r.kind === "app" ? `/apps/${r.id}` : `/databases/${r.id}`}
              style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--c-tx)", textDecoration: "none", padding: "10px 12px", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", background: "var(--c-el)" }}
            >
              <span style={{ width: 36, height: 36, borderRadius: 8, background: "var(--c-tile)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {r.kind === "app" ? (
                  // Same icon as the app list/detail: upload, picked icon, site favicon, image brand, catalog logo, source icon.
                  <AppLogo {...appLogoProps({ ...r, source: (r.source ?? "IMAGE") as AppSource })} size={22} />
                ) : (
                  <ResourceIcon
                    iconUrl={databaseIconUrl(r.id, r.iconUpdatedAt)}
                    iconKey={r.iconKey}
                    image={r.image}
                    brand={r.engine && ENGINE_LOGO[r.engine] ? { logo: ENGINE_LOGO[r.engine], slug: r.engine } : null}
                    name={r.name}
                    size={22}
                    fallback={<Icon size={18} color="var(--c-a)" />}
                  />
                )}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <TagChips tags={r.tags} />
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.url ? r.url : r.engine ?? ""}
                  {r.serverName ? ` · ${r.serverName}` : ""}
                </div>
              </div>
              <StatusPill label={r.status} color={color} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
